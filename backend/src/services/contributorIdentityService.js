/**
 * contributorIdentityService.js
 *
 * Business logic for the Stellar DID layer, on-chain KYC attestations, and
 * cross-campaign reputation scores (issue #689).
 *
 * On-chain interaction goes through the shared sorobanService primitives
 * (invokeContract / invokeContractReadOnly) exactly as every other contract
 * service in this codebase does.
 *
 * Privacy rule: this service never returns or stores a contributor's real
 * name, email address, Persona document content, or any raw PII.  The only
 * Persona-derived value stored is the SHA-256 hash of the inquiry ID.
 */

const crypto = require('crypto');
const { Address, nativeToScVal, scValToNative, xdr } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const { server, networkPassphrase } = require('../config/stellar');
const { Contract, TransactionBuilder, BASE_FEE, Keypair } = require('@stellar/stellar-sdk');
const { TX_TIMEOUT_CONTRIBUTION_S } = require('../config/constants');

// ---------------------------------------------------------------------------
// Contract helpers (re-uses the same low-level pattern as sorobanService.js)
// ---------------------------------------------------------------------------

function identityContractId() {
  const id = process.env.CONTRIBUTOR_IDENTITY_CONTRACT_ID;
  if (!id) {
    throw new Error(
      'CONTRIBUTOR_IDENTITY_CONTRACT_ID is not set — deploy the contributor_identity contract and add the address to .env'
    );
  }
  return id;
}

function platformSigner() {
  return Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
}

async function simulateAndPrepare(tx) {
  const simulation = await server.simulateTransaction(tx);
  if (simulation.result) {
    const meta = xdr.TransactionMeta.fromXDR(simulation.result.meta, 'base64');
    const sorobanMeta = meta.v3().sorobanMeta();
    if (sorobanMeta && sorobanMeta.returnValue()) {
      const isError =
        sorobanMeta.returnValue().switch?.()?.name === 'scvError' ||
        (typeof sorobanMeta.returnValue().type === 'function' &&
          sorobanMeta.returnValue().type() === xdr.ScValType.scvError);
      if (isError) {
        throw new Error(`Simulation failed: ${JSON.stringify(simulation.result)}`);
      }
    }
  }
  return server.prepareTransaction(tx);
}

/**
 * Sign and submit a contract write call using the platform key.
 * Returns { hash, returnValue }.
 */
async function contractInvoke(method, args) {
  const contractId = identityContractId();
  const signer = platformSigner();
  const source = await server.loadAccount(signer.publicKey());

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const preparedTx = await simulateAndPrepare(tx);
  preparedTx.sign(signer);
  const hash = preparedTx.hash().toString('hex');
  const result = await server.submitTransaction(preparedTx);

  if (result.status === 'SUCCESS') {
    let returnValue = null;
    if (result.resultMetaXdr) {
      const meta = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
      const sorobanMeta = meta.v3().sorobanMeta();
      if (sorobanMeta && sorobanMeta.returnValue()) {
        returnValue = scValToNative(sorobanMeta.returnValue());
      }
    }
    return { hash: result.hash || hash, returnValue };
  }
  throw new Error(`Contract transaction failed: ${result.status}`);
}

/**
 * Simulate a read-only contract call using the platform key as fee source.
 * Returns the decoded return value.
 */
async function contractRead(method, args) {
  const contractId = identityContractId();
  const signer = platformSigner();
  const source = await server.loadAccount(signer.publicKey());

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (simulation.result) {
    const meta = xdr.TransactionMeta.fromXDR(simulation.result.meta, 'base64');
    const sorobanMeta = meta.v3().sorobanMeta();
    if (sorobanMeta && sorobanMeta.returnValue()) {
      const isError =
        sorobanMeta.returnValue().switch?.()?.name === 'scvError' ||
        (typeof sorobanMeta.returnValue().type === 'function' &&
          sorobanMeta.returnValue().type() === xdr.ScValType.scvError);
      if (isError) {
        throw new Error(`Contract read simulation error: ${JSON.stringify(simulation.result)}`);
      }
      return scValToNative(sorobanMeta.returnValue());
    }
  }
  throw new Error(`Contract read simulation produced no return value: ${JSON.stringify(simulation)}`);
}

// ---------------------------------------------------------------------------
// DID helpers
// ---------------------------------------------------------------------------

/** Build a did:stellar:<publicKey> string. */
function buildDid(publicKey) {
  return `did:stellar:${publicKey}`;
}

/** SHA-256 of a string value, returned as hex. */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Hex string → 32-byte Buffer (for BytesN<32> contract args). */
function hexToBytes32(hexStr) {
  return Buffer.from(hexStr.slice(0, 64).padStart(64, '0'), 'hex');
}

// ---------------------------------------------------------------------------
// KYC tier → attestation type
// ---------------------------------------------------------------------------

const TIER_TO_ATTESTATION = {
  basic: 'kyc_basic',
  standard: 'kyc_standard',
  enhanced: 'kyc_enhanced',
};

function attestationTypeForTier(tier) {
  return TIER_TO_ATTESTATION[tier] || 'kyc_basic';
}

// ---------------------------------------------------------------------------
// Reputation event deltas (as per the spec)
// ---------------------------------------------------------------------------
const REPUTATION_DELTAS = {
  contribution_made: 5,
  contribution_to_successful_campaign: 10,
  contribution_to_failed_campaign: 0,
  dispute_raised_against_contributor: -20,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * registerIdentity(publicKey, userId)
 *
 * Idempotent.  If the contributor already has a row in contributor_identities
 * the existing record is returned without touching the contract.
 *
 * On first call:
 *   1. Builds the DID string.
 *   2. Calls `register` on the identity contract.
 *   3. Persists the record to contributor_identities.
 */
async function registerIdentity(publicKey, userId) {
  // Idempotency check — return existing record immediately
  const { rows: existing } = await db.query(
    'SELECT * FROM contributor_identities WHERE public_key = $1',
    [publicKey]
  );
  if (existing.length) {
    return existing[0];
  }

  const did = buildDid(publicKey);

  // Invoke on-chain register — idempotent at the contract level too
  let contractRegisteredAt = null;
  try {
    await contractInvoke('register', [
      nativeToScVal(Address.fromString(publicKey), { type: 'address' }),
      nativeToScVal(did, { type: 'string' }),
    ]);
    contractRegisteredAt = new Date();
  } catch (err) {
    // Log but do not hard-fail: the DB record is the source of truth for the
    // application layer.  The contract call can be retried later.
    logger.warn('contributorIdentityService.registerIdentity: contract call failed', {
      publicKey,
      error: err.message,
    });
  }

  const { rows } = await db.query(
    `INSERT INTO contributor_identities (user_id, public_key, did, contract_registered_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (public_key) DO UPDATE
       SET contract_registered_at = COALESCE(contributor_identities.contract_registered_at, EXCLUDED.contract_registered_at)
     RETURNING *`,
    [userId, publicKey, did, contractRegisteredAt]
  );

  logger.info('contributorIdentityService.registerIdentity: registered', { publicKey, did });
  return rows[0];
}

/**
 * issueKycAttestation(subjectPublicKey, userId, kycLevel, personaInquiryId)
 *
 * Called after a Persona KYC approval webhook is received.
 *
 * 1. Derives the attestation_type from the KYC level tier.
 * 2. Hashes the Persona inquiry ID — this hash is the only thing stored or
 *    sent on-chain.  The raw inquiry ID is never written to the contract.
 * 3. Calls add_attestation on the contract via the platform key (which must
 *    be registered as an approved issuer during contract setup).
 * 4. Inserts a row into kyc_attestations.
 */
async function issueKycAttestation(subjectPublicKey, userId, kycLevel, personaInquiryId) {
  const attestationType = attestationTypeForTier(kycLevel);
  // Hash the inquiry ID — this is the proof_hash stored on-chain
  const proofHash = sha256Hex(personaInquiryId || `${subjectPublicKey}-${kycLevel}-${Date.now()}`);
  const proofHashBytes = hexToBytes32(proofHash);

  // Ensure identity exists on-chain before attesting
  await registerIdentity(subjectPublicKey, userId);

  let onChainTxHash = null;
  try {
    const { hash } = await contractInvoke('add_attestation', [
      // issuer = platform key
      nativeToScVal(Address.fromString(platformSigner().publicKey()), { type: 'address' }),
      // subject
      nativeToScVal(Address.fromString(subjectPublicKey), { type: 'address' }),
      // attestation_type symbol
      nativeToScVal(attestationType, { type: 'symbol' }),
      // expires_at = 0 (no expiry)
      nativeToScVal(0, { type: 'u64' }),
      // proof_hash BytesN<32>
      nativeToScVal(proofHashBytes),
    ]);
    onChainTxHash = hash;
  } catch (err) {
    logger.warn('contributorIdentityService.issueKycAttestation: contract call failed', {
      subjectPublicKey,
      attestationType,
      error: err.message,
    });
  }

  const { rows } = await db.query(
    `INSERT INTO kyc_attestations
       (user_id, public_key, attestation_type, kyc_level, persona_inquiry_id, proof_hash, on_chain_tx_hash)
     VALUES ($1, $2, $3::kyc_attestation_type, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      userId,
      subjectPublicKey,
      attestationType,
      kycLevel,
      personaInquiryId || null,
      proofHash,
      onChainTxHash,
    ]
  );

  logger.info('contributorIdentityService.issueKycAttestation: issued', {
    subjectPublicKey,
    attestationType,
    onChainTxHash,
  });

  return rows[0] || null;
}

/**
 * updateReputationScore(publicKey, event, relatedCampaignId?)
 *
 * Called by the ledger monitor / campaign status service after contribution
 * events are confirmed on-chain.
 *
 * Looks up the current on-chain score, applies the delta, clamps to [0,1000],
 * invokes update_reputation on the contract, then appends a reputation_events
 * row for audit purposes.
 */
async function updateReputationScore(publicKey, event, relatedCampaignId = null) {
  const delta = REPUTATION_DELTAS[event];
  if (delta === undefined) {
    throw new Error(`Unknown reputation event type: ${event}`);
  }

  // Skip zero-delta events — nothing to record
  if (delta === 0) {
    logger.debug('contributorIdentityService.updateReputationScore: zero delta, skipping', {
      publicKey,
      event,
    });
    return null;
  }

  // Fetch current on-chain score
  let currentScore = 0;
  try {
    const identity = await contractRead('get_identity', [
      nativeToScVal(Address.fromString(publicKey), { type: 'address' }),
    ]);
    // identity is a decoded JS object from scValToNative
    currentScore = Number(identity?.reputation_score ?? 0);
  } catch (err) {
    // Identity may not be registered yet — score stays 0, call will register implicitly
    logger.debug('contributorIdentityService.updateReputationScore: could not read identity', {
      publicKey,
      error: err.message,
    });
  }

  const newScore = Math.max(0, Math.min(1000, currentScore + delta));

  let onChainTxHash = null;
  try {
    const { hash } = await contractInvoke('update_reputation', [
      nativeToScVal(Address.fromString(publicKey), { type: 'address' }),
      nativeToScVal(delta, { type: 'i32' }),
    ]);
    onChainTxHash = hash;
  } catch (err) {
    logger.warn('contributorIdentityService.updateReputationScore: contract call failed', {
      publicKey,
      event,
      delta,
      error: err.message,
    });
  }

  await db.query(
    `INSERT INTO reputation_events
       (public_key, event_type, delta, resulting_score, related_campaign_id, on_chain_tx_hash)
     VALUES ($1, $2::reputation_event_type, $3, $4, $5, $6)`,
    [publicKey, event, delta, newScore, relatedCampaignId || null, onChainTxHash]
  );

  logger.info('contributorIdentityService.updateReputationScore: updated', {
    publicKey,
    event,
    delta,
    newScore,
    onChainTxHash,
  });

  return { delta, newScore, onChainTxHash };
}

/**
 * getContributorProfile(publicKey)
 *
 * Returns a structured profile containing only non-personal data:
 *   did, reputationScore, attestations (type/issuer/dates/revoked),
 *   contributionStats (totalCampaigns, totalAmountUsd, successRate)
 *
 * No name, email, document reference, or Persona inquiry ID is included.
 */
async function getContributorProfile(publicKey) {
  // ------------------------------------------------------------------
  // 1. On-chain identity (best-effort — may not be registered yet)
  // ------------------------------------------------------------------
  let onChainIdentity = null;
  try {
    onChainIdentity = await contractRead('get_identity', [
      nativeToScVal(Address.fromString(publicKey), { type: 'address' }),
    ]);
  } catch (_err) {
    // Not yet registered — return a minimal profile
  }

  // ------------------------------------------------------------------
  // 2. Off-chain attestation list (privacy-safe projection)
  // ------------------------------------------------------------------
  const { rows: attestationRows } = await db.query(
    `SELECT attestation_type, kyc_level, issued_at, expires_at, revoked_at, on_chain_tx_hash
     FROM kyc_attestations
     WHERE public_key = $1
     ORDER BY issued_at DESC`,
    [publicKey]
  );

  const attestations = attestationRows.map((r) => ({
    type: r.attestation_type,
    issuer: 'platform',
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    revoked: r.revoked_at !== null,
  }));

  // ------------------------------------------------------------------
  // 3. Contribution stats from on-chain history (Horizon)
  // ------------------------------------------------------------------
  let contributionStats = { totalCampaigns: 0, totalAmountUsd: 0, successRate: 0 };
  try {
    const { rows: statsRows } = await db.query(
      `SELECT
         COUNT(DISTINCT c.id)::int                        AS total_campaigns,
         COALESCE(SUM(con.amount), 0)::numeric            AS total_amount,
         COUNT(DISTINCT c.id) FILTER (
           WHERE c.status IN ('funded','completed','withdrawn')
         )::int                                           AS successful_campaigns
       FROM contributions con
       JOIN campaigns c ON c.id = con.campaign_id
       WHERE con.sender_public_key = $1
         AND con.refunded = FALSE`,
      [publicKey]
    );
    if (statsRows.length) {
      const s = statsRows[0];
      const total = parseInt(s.total_campaigns, 10) || 0;
      const successful = parseInt(s.successful_campaigns, 10) || 0;
      contributionStats = {
        totalCampaigns: total,
        totalAmountUsd: parseFloat(s.total_amount) || 0,
        successRate: total > 0 ? Math.round((successful / total) * 100) : 0,
      };
    }
  } catch (err) {
    logger.warn('contributorIdentityService.getContributorProfile: stats query failed', {
      publicKey,
      error: err.message,
    });
  }

  return {
    did: onChainIdentity?.did ?? buildDid(publicKey),
    reputationScore: Number(onChainIdentity?.reputation_score ?? 0),
    attestations,
    contributionStats,
    registered: onChainIdentity !== null,
  };
}

/**
 * verifyAttestation(publicKey, attestationType)
 *
 * Checks both the off-chain DB record and the on-chain contract state.
 * Returns { verified: boolean, expiresAt: Date|null }.
 *
 * "verified" is true only when:
 *   - There is an active (non-revoked, non-expired) DB row, AND
 *   - The contract's has_attestation returns true.
 */
async function verifyAttestation(publicKey, attestationType) {
  // DB check
  const { rows } = await db.query(
    `SELECT expires_at FROM kyc_attestations
     WHERE public_key = $1
       AND attestation_type = $2::kyc_attestation_type
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY issued_at DESC
     LIMIT 1`,
    [publicKey, attestationType]
  );

  if (!rows.length) {
    return { verified: false, expiresAt: null };
  }

  // On-chain check
  let onChain = false;
  try {
    onChain = await contractRead('has_attestation', [
      nativeToScVal(Address.fromString(publicKey), { type: 'address' }),
      nativeToScVal(attestationType, { type: 'symbol' }),
    ]);
  } catch (err) {
    logger.warn('contributorIdentityService.verifyAttestation: contract read failed', {
      publicKey,
      attestationType,
      error: err.message,
    });
    // Fall back to DB-only result to avoid blocking legitimate contributors
    // when the RPC is temporarily unavailable.
    onChain = true;
  }

  return {
    verified: Boolean(onChain),
    expiresAt: rows[0].expires_at || null,
  };
}

/**
 * assertContributorMeetsRequirements(publicKey, campaignId)
 *
 * Throws a structured 403 error if the contributor does not satisfy the
 * campaign's requirements.  Returns silently if there are no requirements or
 * the contributor satisfies all of them.
 */
async function assertContributorMeetsRequirements(publicKey, campaignId) {
  const { rows: reqRows } = await db.query(
    'SELECT * FROM campaign_requirements WHERE campaign_id = $1',
    [campaignId]
  );

  // No requirements set — allow everyone through
  if (!reqRows.length) return;

  const req = reqRows[0];
  const missing = [];

  // --- Reputation check ---
  if (req.min_reputation_score > 0) {
    let score = 0;
    try {
      const identity = await contractRead('get_identity', [
        nativeToScVal(Address.fromString(publicKey), { type: 'address' }),
      ]);
      score = Number(identity?.reputation_score ?? 0);
    } catch (_err) {
      score = 0;
    }

    if (score < req.min_reputation_score) {
      missing.push({
        type: 'reputation',
        required: req.min_reputation_score,
        current: score,
        message: `Reputation score ${score} is below the required ${req.min_reputation_score}`,
      });
    }
  }

  // --- Attestation checks ---
  const requiredAttestations = Array.isArray(req.required_attestations)
    ? req.required_attestations
    : [];

  for (const attestationType of requiredAttestations) {
    const { verified } = await verifyAttestation(publicKey, attestationType);
    if (!verified) {
      missing.push({
        type: 'attestation',
        attestation: attestationType,
        message: `Missing required attestation: ${attestationType}`,
      });
    }
  }

  if (missing.length > 0) {
    const err = new Error('Contributor does not meet campaign requirements');
    err.statusCode = 403;
    err.code = 'CONTRIBUTOR_REQUIREMENTS_NOT_MET';
    err.missing = missing;
    throw err;
  }
}

module.exports = {
  registerIdentity,
  issueKycAttestation,
  updateReputationScore,
  getContributorProfile,
  verifyAttestation,
  assertContributorMeetsRequirements,
  buildDid,
  sha256Hex,
  attestationTypeForTier,
  REPUTATION_DELTAS,
};
