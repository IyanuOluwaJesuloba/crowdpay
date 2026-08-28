const fs = require('fs');
const path = require('path');
const { nativeToScVal, Address, Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const soroban = require('./sorobanService');
const { withDecryptedWalletSecret } = require('./walletSecrets');

/**
 * Compiled campaign_treasury WASM. Built from contracts/soroban with
 * `cargo build --release --target wasm32v1-none -p campaign_treasury`.
 */
const TREASURY_WASM_PATH =
  process.env.TREASURY_WASM_PATH ||
  path.resolve(
    __dirname,
    '../../../contracts/soroban/target/wasm32v1-none/release/campaign_treasury.wasm'
  );

const CONTRACT_VERSION = 1;

/**
 * Contract error ordinals, mirroring the TreasuryError enum in
 * contracts/soroban/contracts/campaign_treasury/src/lib.rs. The contract returns
 * an ordinal; the API surfaces the symbolic code so clients never depend on a
 * number that could shift when the enum grows.
 */
const CONTRACT_ERRORS = {
  1: 'ALREADY_INITIALIZED',
  2: 'NOT_INITIALIZED',
  3: 'HOLD_PERIOD_NOT_ELAPSED',
  4: 'EXCEEDS_MAX_WITHDRAWAL_PCT',
  5: 'COOLDOWN_NOT_ELAPSED',
  6: 'INSUFFICIENT_BALANCE',
  7: 'TREASURY_PAUSED',
  8: 'AUDITOR_NOT_CONFIGURED',
  9: 'PENDING_NOT_FOUND',
  10: 'INVALID_POLICY',
  11: 'AUTO_REFUND_DISABLED',
  12: 'REFUND_CONDITIONS_NOT_MET',
  13: 'INVALID_AMOUNT',
  14: 'HISTORY_FULL',
};

/** Policy field bounds, kept in step with the CHECK constraints on treasury_policies. */
const POLICY_BOUNDS = {
  minHoldDays: [0, 90],
  maxSingleWithdrawalPct: [1, 100],
  withdrawalCooldownHours: [0, 168],
};

function fail(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Maps a Soroban failure onto the contract's symbolic error code. Simulation
 * failures surface as `Error(Contract, #N)` in the RPC response, so the ordinal is
 * recovered from the message when the SDK does not hand back a structured error.
 */
function translateContractError(err) {
  const raw = err?.message || '';
  const match = /#(\d+)/.exec(raw);
  const code = match ? CONTRACT_ERRORS[Number(match[1])] : null;
  if (!code) return err;
  const translated = fail(`Treasury rejected the call: ${code}`, 422, code);
  translated.cause = err;
  return translated;
}

function validatePolicy(policy) {
  const normalized = {
    minHoldDays: Number(policy?.minHoldDays ?? 0),
    maxSingleWithdrawalPct: Number(policy?.maxSingleWithdrawalPct ?? 100),
    withdrawalCooldownHours: Number(policy?.withdrawalCooldownHours ?? 0),
    requireAuditorForAbove: String(policy?.requireAuditorForAbove ?? '0'),
    autoRefundOnMiss: Boolean(policy?.autoRefundOnMiss),
  };

  for (const [field, [min, max]] of Object.entries(POLICY_BOUNDS)) {
    const value = normalized[field];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw fail(`${field} must be an integer between ${min} and ${max}`, 400, 'INVALID_POLICY');
    }
  }
  if (!/^\d+(\.\d{1,7})?$/.test(normalized.requireAuditorForAbove)) {
    throw fail('requireAuditorForAbove must be a non-negative amount', 400, 'INVALID_POLICY');
  }
  return normalized;
}

/** Stellar amounts carry 7 decimals; the contract works in stroops. */
function toStroops(amount) {
  const [whole, fraction = ''] = String(amount).split('.');
  return BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, '0').slice(0, 7));
}

function fromStroops(stroops) {
  const value = BigInt(stroops);
  const whole = value / 10000000n;
  const fraction = (value % 10000000n).toString().padStart(7, '0');
  return `${whole}.${fraction}`;
}

function i128(amount) {
  return nativeToScVal(toStroops(amount), { type: 'i128' });
}

function addressArg(publicKey) {
  return nativeToScVal(Address.fromString(publicKey), { type: 'address' });
}

/** Soroban symbols cap at 32 characters; memos are truncated rather than rejected. */
function symbolArg(value) {
  return nativeToScVal((value || 'w').slice(0, 32), { type: 'symbol' });
}

async function loadCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT id, creator_id, target_amount, deadline, asset_type, wallet_mode,
            contract_id, auditor_public_key, status
     FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!rows.length) throw fail('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');
  return rows[0];
}

function requireContractMode(campaign) {
  if (campaign.wallet_mode !== 'contract' || !campaign.contract_id) {
    throw fail('This campaign does not use a contract treasury', 409, 'NOT_CONTRACT_WALLET');
  }
  return campaign.contract_id;
}

/**
 * Loads the encrypted wallet secret for whichever user must satisfy
 * `require_auth()` on-chain (the creator for request_withdrawal, the auditor for
 * approve_withdrawal). The contract checks the caller's own address, so signing
 * with PLATFORM_SECRET_KEY on their behalf is never valid — only their own key
 * authorizes their own address.
 */
async function loadCustodialSigner(userId, role, missingCode) {
  const { rows } = await db.query(
    'SELECT wallet_type, wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
    [userId]
  );
  const user = rows[0];
  if (!user?.wallet_public_key) {
    throw fail(`Campaign ${role} has no wallet`, 409, missingCode);
  }
  if (user.wallet_type === 'freighter') {
    throw fail(
      `Contract-treasury signing requires the ${role}'s server-held wallet key; non-custodial (Freighter) ${role} wallets are not yet supported here`,
      501,
      'FREIGHTER_SIGNING_UNSUPPORTED'
    );
  }
  return {
    userId,
    walletPublicKey: user.wallet_public_key,
    walletSecretEncrypted: user.wallet_secret_encrypted,
  };
}

/**
 * Persists the policy a campaign will deploy with. Only settable before the
 * campaign goes live, since the contract takes the policy at initialize() and the
 * on-chain copy is the one that governs.
 */
async function setPolicy(campaignId, policy) {
  const campaign = await loadCampaign(campaignId);
  if (campaign.contract_id) {
    throw fail(
      'The treasury is already deployed; its policy is fixed on-chain',
      409,
      'TREASURY_ALREADY_DEPLOYED'
    );
  }
  if (campaign.status !== 'draft' && campaign.status !== 'active') {
    throw fail('The policy can only be set before the campaign goes live', 409, 'CAMPAIGN_LIVE');
  }

  const normalized = validatePolicy(policy);
  const { rows } = await db.query(
    `INSERT INTO treasury_policies (
       campaign_id, min_hold_days, max_single_withdrawal_pct,
       withdrawal_cooldown_hours, require_auditor_for_above, auto_refund_on_miss
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (campaign_id) DO UPDATE SET
       min_hold_days = EXCLUDED.min_hold_days,
       max_single_withdrawal_pct = EXCLUDED.max_single_withdrawal_pct,
       withdrawal_cooldown_hours = EXCLUDED.withdrawal_cooldown_hours,
       require_auditor_for_above = EXCLUDED.require_auditor_for_above,
       auto_refund_on_miss = EXCLUDED.auto_refund_on_miss
     RETURNING *`,
    [
      campaignId,
      normalized.minHoldDays,
      normalized.maxSingleWithdrawalPct,
      normalized.withdrawalCooldownHours,
      normalized.requireAuditorForAbove,
      normalized.autoRefundOnMiss,
    ]
  );
  return rows[0];
}

async function getPolicyRow(campaignId) {
  const { rows } = await db.query('SELECT * FROM treasury_policies WHERE campaign_id = $1', [
    campaignId,
  ]);
  return rows[0] || null;
}

function policyScVal(row, assetIssuerDecimals = true) {
  return nativeToScVal(
    {
      min_hold_days: row.min_hold_days,
      max_single_withdrawal_pct: row.max_single_withdrawal_pct,
      withdrawal_cooldown_hours: row.withdrawal_cooldown_hours,
      require_auditor_for_above: assetIssuerDecimals
        ? toStroops(row.require_auditor_for_above)
        : BigInt(row.require_auditor_for_above),
      auto_refund_on_miss: row.auto_refund_on_miss,
    },
    {
      type: {
        min_hold_days: ['symbol', 'u32'],
        max_single_withdrawal_pct: ['symbol', 'u32'],
        withdrawal_cooldown_hours: ['symbol', 'u32'],
        require_auditor_for_above: ['symbol', 'i128'],
        auto_refund_on_miss: ['symbol', 'bool'],
      },
    }
  );
}

/**
 * Uploads the WASM, instantiates it, and initializes it with the campaign's saved
 * policy. Flips the campaign into contract mode only once the contract answers,
 * so a half-deployed campaign never presents itself as contract-backed.
 */
async function deployTreasury(campaignId, { auditorPublicKey = null, assetContractId } = {}) {
  const campaign = await loadCampaign(campaignId);
  if (campaign.contract_id) {
    throw fail('This campaign already has a treasury', 409, 'TREASURY_ALREADY_DEPLOYED');
  }
  const policy = await getPolicyRow(campaignId);
  if (!policy) {
    throw fail('Set a treasury policy before deploying', 409, 'POLICY_NOT_SET');
  }

  const platformSecret = process.env.PLATFORM_SECRET_KEY;
  const platform = Keypair.fromSecret(platformSecret);

  const wasm = fs.readFileSync(TREASURY_WASM_PATH);
  const wasmHash = await soroban.uploadContractWasm(wasm, platformSecret);
  const { contractId } = await soroban.createContractFromWasmHash({
    wasmHash,
    signerSecret: platformSecret,
    address: platform.publicKey(),
  });

  const { rows: creatorRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [campaign.creator_id]
  );
  const creatorKey = creatorRows[0]?.wallet_public_key;
  if (!creatorKey) throw fail('Campaign creator has no wallet', 409, 'CREATOR_WALLET_MISSING');

  const deadline = campaign.deadline
    ? Math.floor(new Date(campaign.deadline).getTime() / 1000)
    : 0;

  try {
    await soroban.invokeContract({
      contractId,
      method: 'initialize',
      args: [
        symbolArg(`c${String(campaignId).replace(/-/g, '').slice(0, 20)}`),
        addressArg(creatorKey),
        addressArg(platform.publicKey()),
        nativeToScVal(
          auditorPublicKey ? Address.fromString(auditorPublicKey) : null,
          auditorPublicKey ? { type: 'address' } : undefined
        ),
        policyScVal(policy),
        nativeToScVal(deadline, { type: 'u64' }),
        i128(campaign.target_amount),
        addressArg(assetContractId),
      ],
      signerSecret: platformSecret,
    });
  } catch (err) {
    logger.error('Treasury initialize failed', { campaign_id: campaignId, error: err.message });
    throw translateContractError(err);
  }

  const { rows } = await db.query(
    `UPDATE campaigns
     SET wallet_mode = 'contract', contract_id = $2,
         contract_version = $3, auditor_public_key = $4
     WHERE id = $1
     RETURNING id, wallet_mode, contract_id, contract_version, auditor_public_key`,
    [campaignId, contractId, CONTRACT_VERSION, auditorPublicKey]
  );
  logger.info('Treasury deployed', { campaign_id: campaignId, contract_id: contractId });
  return rows[0];
}

/**
 * Books a confirmed payment on-chain. Called by the Horizon stream listener once a
 * contribution is final, so the contract's totals track the ledger rather than the
 * backend's optimistic view.
 */
async function indexContribution(campaignId, { contributor, amount, txHash }) {
  const campaign = await loadCampaign(campaignId);
  const contractId = requireContractMode(campaign);

  try {
    await soroban.invokeContract({
      contractId,
      method: 'receive_contribution',
      args: [addressArg(contributor), i128(amount)],
      signerSecret: process.env.PLATFORM_SECRET_KEY,
    });
  } catch (err) {
    logger.error('Treasury contribution indexing failed', {
      campaign_id: campaignId,
      tx_hash: txHash,
      error: err.message,
    });
    throw translateContractError(err);
  }
  return { indexed: true, txHash };
}

/**
 * Simulates request_withdrawal so policy violations are reported before anything is
 * submitted, then records the resulting row. A request above the auditor threshold
 * comes back as pending rather than an XDR to sign.
 */
async function buildWithdrawalRequest(campaignId, { amount, destination, memo, requestedBy }) {
  const campaign = await loadCampaign(campaignId);
  const contractId = requireContractMode(campaign);
  const creator = await loadCustodialSigner(campaign.creator_id, 'creator', 'CREATOR_WALLET_MISSING');

  let result;
  try {
    result = await withDecryptedWalletSecret(
      creator.walletSecretEncrypted,
      { userId: creator.userId, walletPublicKey: creator.walletPublicKey },
      (creatorSecret) =>
        soroban.invokeContract({
          contractId,
          method: 'request_withdrawal',
          args: [i128(amount), addressArg(destination), symbolArg(memo)],
          signerSecret: creatorSecret,
        })
    );
  } catch (err) {
    throw translateContractError(err);
  }

  // The contract returns the pending id when the auditor must sign, else null.
  const pendingId = result === null || result === undefined ? null : Number(result);
  const status = pendingId === null ? 'completed' : 'pending_auditor';

  const { rows } = await db.query(
    `INSERT INTO withdrawal_requests (
       campaign_id, requested_by, amount, asset, destination_key,
       status, contract_pending_id, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, status, contract_pending_id, amount, destination_key`,
    [
      campaignId,
      requestedBy,
      amount,
      campaign.asset_type,
      destination,
      status,
      pendingId,
      status === 'completed' ? new Date() : null,
    ]
  );

  return {
    type: pendingId === null ? 'immediate' : 'pending_auditor',
    pendingId,
    withdrawal: rows[0],
  };
}

/** Auditor sign-off; releases a withdrawal the contract parked. */
async function approvePendingWithdrawal(campaignId, pendingId, { approverId } = {}) {
  const campaign = await loadCampaign(campaignId);
  const contractId = requireContractMode(campaign);
  if (!approverId) {
    throw fail('Auditor approval requires the authenticated approver', 400, 'VALIDATION_ERROR');
  }
  const auditor = await loadCustodialSigner(approverId, 'auditor', 'AUDITOR_WALLET_MISSING');

  if (campaign.auditor_public_key && auditor.walletPublicKey !== campaign.auditor_public_key) {
    throw fail('The signer does not match the configured auditor', 403, 'AUDITOR_MISMATCH');
  }

  try {
    await withDecryptedWalletSecret(
      auditor.walletSecretEncrypted,
      { userId: auditor.userId, walletPublicKey: auditor.walletPublicKey },
      (auditorSecret) =>
        soroban.invokeContract({
          contractId,
          method: 'approve_withdrawal',
          args: [nativeToScVal(Number(pendingId), { type: 'u32' })],
          signerSecret: auditorSecret,
        })
    );
  } catch (err) {
    throw translateContractError(err);
  }

  const { rows } = await db.query(
    `UPDATE withdrawal_requests
     SET status = 'completed', completed_at = NOW()
     WHERE campaign_id = $1 AND contract_pending_id = $2 AND status = 'pending_auditor'
     RETURNING id, status, amount, destination_key, completed_at`,
    [campaignId, pendingId]
  );
  if (!rows.length) {
    throw fail('No pending withdrawal with that id', 404, 'PENDING_NOT_FOUND');
  }
  return rows[0];
}

/** Reads live contract state. Never served from the database cache. */
async function getTreasuryStatus(campaignId) {
  const campaign = await loadCampaign(campaignId);
  const contractId = requireContractMode(campaign);

  const read = (method) =>
    soroban.invokeContractReadOnly({ contractId, method, args: [] });

  const [policy, totalReceived, totalWithdrawn, history, pending, paused] = await Promise.all([
    read('get_policy'),
    read('get_total_received'),
    read('get_total_withdrawn'),
    read('get_withdrawal_history'),
    read('get_pending_withdrawals'),
    read('is_paused'),
  ]);

  return {
    contractId,
    policy: {
      minHoldDays: Number(policy.min_hold_days),
      maxSingleWithdrawalPct: Number(policy.max_single_withdrawal_pct),
      withdrawalCooldownHours: Number(policy.withdrawal_cooldown_hours),
      requireAuditorForAbove: fromStroops(policy.require_auditor_for_above),
      autoRefundOnMiss: Boolean(policy.auto_refund_on_miss),
    },
    totalReceived: fromStroops(totalReceived || 0),
    totalWithdrawn: fromStroops(totalWithdrawn || 0),
    available: fromStroops(BigInt(totalReceived || 0) - BigInt(totalWithdrawn || 0)),
    paused: Boolean(paused),
    withdrawalHistory: (history || []).map((record) => ({
      id: Number(record.id),
      amount: fromStroops(record.amount),
      destination: String(record.destination),
      executedAt: new Date(Number(record.executed_at) * 1000).toISOString(),
      requester: String(record.requester),
      approvedBy: record.approved_by ? String(record.approved_by) : null,
    })),
    pendingWithdrawals: (pending || []).map((entry) => ({
      id: Number(entry.id),
      amount: fromStroops(entry.amount),
      destination: String(entry.destination),
      createdAt: new Date(Number(entry.created_at) * 1000).toISOString(),
    })),
  };
}

/** Returns every contribution when the campaign missed its goal. */
async function triggerAutoRefund(campaignId, { triggeredBy = null } = {}) {
  const campaign = await loadCampaign(campaignId);
  const contractId = requireContractMode(campaign);

  let refunded;
  try {
    refunded = await soroban.invokeContract({
      contractId,
      method: 'trigger_auto_refund',
      args: [],
      signerSecret: process.env.PLATFORM_SECRET_KEY,
    });
  } catch (err) {
    throw translateContractError(err);
  }

  const { rows: contributorRows } = await db.query(
    'SELECT COUNT(DISTINCT user_id)::int AS total FROM contributions WHERE campaign_id = $1',
    [campaignId]
  );

  const { rows } = await db.query(
    `INSERT INTO refund_events (campaign_id, total_refunded, contributor_count, triggered_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, total_refunded, contributor_count, triggered_at`,
    [campaignId, fromStroops(refunded || 0), contributorRows[0]?.total || 0, triggeredBy]
  );

  logger.info('Treasury auto-refund triggered', {
    campaign_id: campaignId,
    total_refunded: rows[0].total_refunded,
  });
  return rows[0];
}

/**
 * Reconciles the contract's history against withdrawal_requests. Acceptance
 * criterion 6 requires these to agree exactly, so this reports the difference
 * rather than assuming it.
 */
async function reconcileWithdrawals(campaignId) {
  const status = await getTreasuryStatus(campaignId);
  const { rows } = await db.query(
    `SELECT contract_pending_id, amount, destination_key, status
     FROM withdrawal_requests
     WHERE campaign_id = $1 AND status = 'completed'
     ORDER BY created_at ASC`,
    [campaignId]
  );

  const onChainTotal = status.withdrawalHistory.reduce(
    (sum, record) => sum + toStroops(record.amount),
    0n
  );
  const dbTotal = rows.reduce((sum, row) => sum + toStroops(row.amount), 0n);

  return {
    onChainCount: status.withdrawalHistory.length,
    databaseCount: rows.length,
    onChainTotal: fromStroops(onChainTotal),
    databaseTotal: fromStroops(dbTotal),
    inSync: status.withdrawalHistory.length === rows.length && onChainTotal === dbTotal,
  };
}

module.exports = {
  CONTRACT_ERRORS,
  CONTRACT_VERSION,
  TREASURY_WASM_PATH,
  setPolicy,
  getPolicyRow,
  deployTreasury,
  indexContribution,
  buildWithdrawalRequest,
  approvePendingWithdrawal,
  getTreasuryStatus,
  triggerAutoRefund,
  reconcileWithdrawals,
  validatePolicy,
  translateContractError,
  toStroops,
  fromStroops,
};
