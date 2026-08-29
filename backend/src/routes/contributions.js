const router = require('express').Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Keypair, TransactionBuilder } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const { networkPassphrase, isTestnet } = require('../config/stellar');
const { requireAuth } = require('../middleware/auth');
const logger = require('../config/logger');
const { sendAlert } = require('../services/alerting');
const { contributionValidation, contributionQuoteValidation, validateRequest } = require('../middleware/validation');
const { parsePagination } = require('../utils/pagination');
const {
  buildUnsignedContributionPayment,
  buildUnsignedContributionPathPayment,
  submitPreparedTransaction,
  getPathPaymentQuote,
  getSupportedAssetCodes,
  isBadSequenceError,
  accountExistsOnLedger,
} = require("../services/stellarService");
const { sendEmail } = require("../services/emailService");
const { SLIPPAGE_BPS, STELLAR_ASSET_DECIMALS_SCALE } = require("../config/constants");
const {
  buildAttributionMemo,
  buildContributionIntent,
  submitCustodialContribution,
} = require('../services/contributionService');
const {
  listUserContributions,
  getContributorDashboard,
  getContributorDashboardCsv,
} = require('../services/userDashboardService');
const { buildTaxReceiptPdf } = require('../services/taxReceiptPdf');
const {
  triggerRefund,
  buildUnsignedEscrowDeposit,
  isContractDepositEligible,
} = require('../services/sorobanService');
const { recordConfirmedContribution } = require('../services/ledgerMonitor');
const { emitWebhookEventForUser, emitWebhookEventForCampaign, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { ERROR_CODES } = require('../services/dispute');
const { assertUserKycVerified } = require('../services/kycService');
const { assertContributorMeetsRequirements } = require('../services/contributorIdentityService');
const asyncHandler = require('../utils/asyncHandler');
const { getReferralCodeFromRequest } = require('../services/referralService');
const { resolveReferralLink } = require('../services/referral');
const { reserveTierSlot } = require('../services/rewardTierService');
const { hashDeviceFingerprint } = require('../utils/deviceFingerprint');

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const PREPARED_CONTRIBUTION_EXPIRES_IN = '10m';

const isTest = process.env.NODE_ENV === 'test';
const contributionPostLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 5,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

/**
 * @openapi
 * tags:
 *   - name: Contributions
 *     description: Contribution creation and quoting
 */

function withReferralMetadata(flowMetadata, campaignId, req) {
  const referralCode = getReferralCodeFromRequest(campaignId, req);
  if (!referralCode) return flowMetadata;
  return { ...flowMetadata, referral_code: referralCode };
}

/**
 * Resolve the `?ref=<code>` affiliate link for a campaign (#675).
 * Throws a 404 INVALID_REFERRAL_CODE error when the code is unknown or belongs
 * to a different campaign; returns null when no code was supplied.
 */
async function resolveAffiliateLink(campaignId, req) {
  const code = typeof req.query?.ref === 'string' ? req.query.ref.trim() : '';
  if (!code) return null;
  return resolveReferralLink({ campaignId, code });
}

function respondInvalidReferralCode(res, err) {
  if (err.code !== 'INVALID_REFERRAL_CODE') return null;
  return res.status(404).json({ error: err.message, code: 'INVALID_REFERRAL_CODE' });
}

function validateFreighterPublicKey(publicKey) {
  try {
    Keypair.fromPublicKey(publicKey);
    return true;
  } catch (_err) {
    return false;
  }
}

async function campaignIsDisputed(campaignId) {
  const { rows } = await db.query('SELECT status FROM campaigns WHERE id = $1', [campaignId]);
  return rows[0]?.status === 'disputed';
}

async function loadActiveCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT c.*, u.email as creator_email FROM campaigns c
     JOIN users u ON c.creator_id = u.id
     WHERE c.id = $1 AND c.status = $2 AND c.deleted_at IS NULL`,
    [campaignId, 'active']
  );
  return rows[0] || null;
}

function createPreparedContributionToken(payload) {
  return jwt.sign(
    { kind: 'prepared_contribution', ...payload },
    process.env.JWT_SECRET,
    { expiresIn: PREPARED_CONTRIBUTION_EXPIRES_IN }
  );
}

function verifyPreparedContributionToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (!payload || payload.kind !== 'prepared_contribution') {
    throw new Error('Invalid contribution prepare token');
  }
  return payload;
}

const CONTRACT_MODE_CROSS_ASSET_MESSAGE = (assetType) =>
  `Cross-asset contributions aren't supported for this campaign's contract-backed treasury yet — please contribute in ${assetType} directly.`;

const RESERVATION_TTL = "10 minutes";

/**
 * Total cap exposure for (campaign, sender): confirmed on-chain contributions
 * plus any not-yet-expired in-flight reservation ('reserved') or already
 * broadcast-but-not-indexed ('submitted') self-custody intent. Used to
 * atomically enforce max_contribution / max_per_user across concurrent
 * /prepare calls (issue #713) — must be called with the (campaign_id,
 * sender_public_key) advisory lock already held.
 */
async function sumContributionCapExposure(client, { campaignId, senderPublicKey, excludeReservationId = null }) {
  const { rows: confirmedRows } = await client.query(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM contributions WHERE campaign_id = $1 AND sender_public_key = $2 AND refunded = FALSE',
    [campaignId, senderPublicKey]
  );
  const { rows: pendingRows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM stellar_transactions
     WHERE campaign_id = $1 AND sender_public_key = $2 AND kind = 'contribution'
       AND status IN ('reserved', 'submitted') AND (expires_at IS NULL OR expires_at > NOW())
       AND ($3::uuid IS NULL OR id != $3)`,
    [campaignId, senderPublicKey, excludeReservationId]
  );
  return parseFloat(confirmedRows[0].total) + parseFloat(pendingRows[0].total);
}

function handleKycGateError(res, err) {
  if (err.code === 'KYC_REQUIRED') {
    return res.status(403).json({
      error: err.message,
      code: 'KYC_REQUIRED',
      kyc_status: err.kyc_status,
    });
  }
  if (err.statusCode === 404) {
    return res.status(404).json({ error: err.message });
  }
  throw err;
}

function validateSubmittedContributionXdr({ signedXdr, unsignedXdr, senderPublicKey }) {
  const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const unsignedTx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);

  if (signedTx.source !== senderPublicKey) {
    throw new Error('Signed transaction source account does not match the prepared contribution');
  }

  if (signedTx.hash().toString('hex') !== unsignedTx.hash().toString('hex')) {
    throw new Error('Signed transaction does not match the prepared contribution');
  }

  if (!signedTx.signatures.length) {
    throw new Error('Signed transaction is missing contributor signature');
  }

  const signer = Keypair.fromPublicKey(senderPublicKey);
  const signatureValid = signedTx.signatures.some((decoratedSignature) => {
    try {
      return signer.verify(signedTx.hash(), decoratedSignature.signature());
    } catch (_err) {
      return false;
    }
  });

  if (!signatureValid) {
    throw new Error('Signed transaction does not include a valid Freighter signature for the contributor');
  }
}

async function getTaxReceiptRows(userId, contributionId = null) {
  const params = [userId];
  let contributionFilter = '';
  if (contributionId) {
    params.push(contributionId);
    contributionFilter = 'AND ctr.id = $2';
  }

  const { rows } = await db.query(
    `SELECT
       ctr.id, ctr.amount, ctr.asset, ctr.tx_hash, ctr.created_at,
       ctr.sender_public_key,
       c.id AS campaign_id, c.title AS campaign_title, c.status AS campaign_status,
       creator.name AS campaign_creator_name,
       u.name AS contributor_name, u.email AS contributor_email
     FROM users u
     JOIN contributions ctr ON ctr.sender_public_key = u.wallet_public_key
     JOIN campaigns c ON c.id = ctr.campaign_id
     LEFT JOIN users creator ON creator.id = c.creator_id
     WHERE u.id = $1 ${contributionFilter}
     ORDER BY ctr.created_at DESC`,
    params
  );
  return rows;
}

function taxReceiptFilename(receipts, fallback = 'crowdpay-tax-receipts.pdf') {
  if (receipts.length === 1) {
    return `crowdpay-tax-receipt-${receipts[0].id}.pdf`;
  }
  return fallback;
}

router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const rows = await listUserContributions(req.user.userId);
  if (rows === null) return res.status(404).json({ error: 'User not found' });
  res.json(rows);
}));

router.get('/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const data = await getContributorDashboard(req.user.userId);
  if (data === null) return res.status(404).json({ error: 'User not found' });
  res.json(data);
}));

router.get('/dashboard/export.csv', requireAuth, asyncHandler(async (req, res) => {
  const csv = await getContributorDashboardCsv(req.user.userId);
  if (csv === null) return res.status(404).json({ error: 'User not found' });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="contributions.csv"');
  res.send(csv);
}));

router.get('/tax-receipts', requireAuth, asyncHandler(async (req, res) => {
  const rows = await getTaxReceiptRows(req.user.userId);
  res.json({
    receipts: rows.map((row) => ({
      id: row.id,
      amount: row.amount,
      asset: row.asset,
      tx_hash: row.tx_hash,
      created_at: row.created_at,
      campaign_id: row.campaign_id,
      campaign_title: row.campaign_title,
      campaign_status: row.campaign_status,
    })),
  });
}));

router.get('/tax-receipts/download', requireAuth, asyncHandler(async (req, res) => {
  const rows = await getTaxReceiptRows(req.user.userId);
  if (!rows.length) return res.status(404).json({ error: 'No contribution receipts found' });

  const pdf = buildTaxReceiptPdf(rows);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${taxReceiptFilename(rows)}"`);
  res.send(pdf);
}));

router.get('/tax-receipts/:id/download', requireAuth, asyncHandler(async (req, res) => {
  const rows = await getTaxReceiptRows(req.user.userId, req.params.id);
  if (!rows.length) return res.status(404).json({ error: 'Tax receipt not found' });

  const pdf = buildTaxReceiptPdf(rows);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${taxReceiptFilename(rows)}"`);
  res.send(pdf);
}));

router.get('/campaign/:campaignId', asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });

  const { rows } = await db.query(
    `SELECT c.id, c.sender_public_key, c.amount, c.asset, c.payment_type,
            c.anchor_id, c.anchor_transaction_id, c.anchor_asset, c.anchor_amount,
            c.source_amount, c.source_asset, c.conversion_rate, c.path,
            c.tx_hash, c.created_at,
            wr.status AS refund_status, wr.tx_hash AS refund_tx_hash,
            c.contract_refunded_at, c.contract_refund_tx_hash,
            COUNT(*) OVER() AS total_count
     FROM contributions c
     LEFT JOIN LATERAL (
       SELECT status, tx_hash
       FROM withdrawal_requests
       WHERE contribution_id = c.id
       ORDER BY created_at DESC
       LIMIT 1
     ) wr ON TRUE
     WHERE c.campaign_id = $1
     ORDER BY c.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.params.campaignId, limit, offset]
  );

  const total = rows[0]?.total_count ?? 0;
  const cleanedRows = rows.map(({ total_count, ...rest }) => rest);
  res.json({ contributions: cleanedRows, total: Number(total), limit, offset });
}));

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const rows = await listUserContributions(req.user.userId);
  if (rows === null) return res.status(404).json({ error: 'User not found' });
  res.json(rows);
}));

router.get('/finalization/:txHash', requireAuth, asyncHandler(async (req, res) => {
  const txHash = req.params.txHash;
  const { rows } = await db.query(
    `SELECT st.id, st.status, st.tx_hash, st.campaign_id, st.contribution_id,
            st.initiated_by_user_id, st.metadata, st.created_at, st.updated_at,
            c.creator_id,
            ct.id AS contribution_row_id, ct.sender_public_key, ct.amount,
            ct.asset, ct.created_at AS contribution_created_at
     FROM stellar_transactions st
     JOIN campaigns c ON c.id = st.campaign_id
     LEFT JOIN contributions ct ON ct.id = st.contribution_id
     WHERE st.tx_hash = $1 AND st.kind = 'contribution'`,
    [txHash]
  );
  if (!rows.length) return res.status(404).json({ error: 'No contribution transaction found' });
  const row = rows[0];

  const { rows: userRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const userPk = userRows[0]?.wallet_public_key;
  const isInitiator = row.initiated_by_user_id === req.user.userId;
  const isCreator = row.creator_id === req.user.userId;
  const isContributor = userPk && row.sender_public_key && row.sender_public_key === userPk;
  const isPlatform = req.user.role === 'admin';

  if (!isInitiator && !isCreator && !isContributor && !isPlatform) {
    return res.status(403).json({ error: 'Not authorized to view this transaction' });
  }

  let finalizationStatus = 'awaiting_ledger';
  if (row.status === 'indexed') finalizationStatus = 'finalized';
  if (row.status === 'failed') finalizationStatus = 'failed';

  res.json({
    tx_hash: row.tx_hash,
    finalization_status: finalizationStatus,
    stellar_transaction_id: row.id,
    campaign_id: row.campaign_id,
    contribution: row.contribution_row_id
      ? {
          id: row.contribution_row_id,
          sender_public_key: row.sender_public_key,
          amount: row.amount,
          asset: row.asset,
          created_at: row.contribution_created_at,
        }
      : null,
    metadata: row.metadata,
    updated_at: row.updated_at,
  });
}));

router.get('/quote', requireAuth, contributionQuoteValidation, validateRequest, asyncHandler(async (req, res) => {
  const { send_asset, dest_asset, dest_amount } = req.query;

  const paths = await getPathPaymentQuote({
    sendAsset: send_asset,
    destAsset: dest_asset,
    destAmount: dest_amount,
  });

  if (!paths.length) {
    return res.status(404).json({ error: 'No conversion path found for requested assets' });
  }

  const bestPath = paths[0];
  const maxSendWithSlippage = (
    parseFloat(bestPath.source_amount) *
    (1 + SLIPPAGE_BPS / 10000)
  ).toFixed(7);

  res.json({
    send_asset,
    dest_asset,
    dest_amount: String(dest_amount),
    quoted_source_amount: bestPath.source_amount,
    max_send_amount: maxSendWithSlippage,
    estimated_rate: (
      parseFloat(dest_amount) / parseFloat(bestPath.source_amount)
    ).toFixed(15),
    path: bestPath.path,
    path_count: paths.length,
  });
}));

router.post('/prepare', requireAuth, contributionValidation, validateRequest, asyncHandler(async (req, res) => {
  try {
    await assertUserKycVerified(req.user.userId);
  } catch (err) {
    const handled = handleKycGateError(res, err);
    if (handled) return handled;
  }

  const { campaign_id, amount, send_asset, sender_public_key, display_name } = req.body;
  if (!sender_public_key) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'sender_public_key is required for Freighter contributions',
        fields: { sender_public_key: 'sender_public_key is required for Freighter contributions' },
      },
    });
  }
  if (!validateFreighterPublicKey(sender_public_key)) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'sender_public_key must be a valid Stellar public key',
        fields: { sender_public_key: 'Invalid Stellar public key' },
      },
    });
  }

  if (await campaignIsDisputed(campaign_id)) {
    return res.status(409).json({
      error: 'This campaign has an open dispute and cannot accept new contributions',
      code: ERROR_CODES.CAMPAIGN_DISPUTED,
    });
  }
  const campaign = await loadActiveCampaign(campaign_id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  // Contributor requirements gate (#689) — check before building any XDR
  try {
    await assertContributorMeetsRequirements(sender_public_key, campaign_id);
  } catch (err) {
    if (err.code === 'CONTRIBUTOR_REQUIREMENTS_NOT_MET') {
      return res.status(403).json({
        error: err.message,
        code: err.code,
        missing: err.missing,
      });
    }
    throw err;
  }

  if (campaign.min_contribution && parseFloat(amount) < parseFloat(campaign.min_contribution)) {
    return res.status(400).json({ error: `Contribution amount is below the minimum limit of ${campaign.min_contribution} ${campaign.asset_type}` });
  }

  const contractMode = isContractDepositEligible(campaign);
  if (contractMode && send_asset !== campaign.asset_type) {
    return res.status(422).json({ error: CONTRACT_MODE_CROSS_ASSET_MESSAGE(campaign.asset_type) });
  }

  // Atomically reserve this intent's exposure against max_contribution /
  // max_per_user before handing back an unsigned transaction — this closes
  // the race where multiple concurrent /prepare calls each see a stale sum
  // and all pass (issue #713).
  const reservationClient = await db.connect();
  let reservation = null;
  let reservationStarted = false;
  try {
    await reservationClient.query('BEGIN');
    reservationStarted = true;
    await reservationClient.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [String(campaign_id), String(sender_public_key)]
    );

    const exposure = await sumContributionCapExposure(reservationClient, {
      campaignId: campaign_id,
      senderPublicKey: sender_public_key,
    });
    const prospectiveTotal = exposure + parseFloat(amount);

    if (campaign.max_contribution && prospectiveTotal > parseFloat(campaign.max_contribution)) {
      await reservationClient.query('ROLLBACK');
      reservationStarted = false;
      return res.status(400).json({ error: `Contribution violates the maximum limit of ${campaign.max_contribution} ${campaign.asset_type} per backer` });
    }
    if (campaign.max_per_user && prospectiveTotal > parseFloat(campaign.max_per_user)) {
      await reservationClient.query('ROLLBACK');
      reservationStarted = false;
      return res.status(400).json({
        error: `You have already contributed ${exposure} ${campaign.asset_type}. The per-contributor limit is ${campaign.max_per_user}.`,
      });
    }

    const { rows: reservedRows } = await reservationClient.query(
      `INSERT INTO stellar_transactions
         (kind, status, campaign_id, initiated_by_user_id, sender_public_key, amount, expires_at, metadata)
       VALUES ('contribution', 'reserved', $1, $2, $3, $4, NOW() + INTERVAL '${RESERVATION_TTL}', '{}'::jsonb)
       RETURNING id`,
      [campaign_id, req.user.userId, sender_public_key, amount]
    );
    reservation = reservedRows[0];

    await reservationClient.query('COMMIT');
    reservationStarted = false;
  } catch (err) {
    if (reservationStarted) {
      try {
        await reservationClient.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.warn('Contribution reservation rollback failed', { error: rollbackErr.message });
      }
    }
    throw err;
  } finally {
    reservationClient.release();
  }

  let affiliateLink;
  try {
    affiliateLink = await resolveAffiliateLink(campaign_id, req);
  } catch (err) {
    const handled = respondInvalidReferralCode(res, err);
    if (handled) return handled;
    throw err;
  }

  try {
    const intent = await buildContributionIntent({
      campaign,
      amount,
      sendAsset: send_asset,
      contributorPublicKey: sender_public_key,
      displayName: display_name,
    });

    const memo = buildAttributionMemo(campaign_id, affiliateLink?.code || null);
    const unsignedXdr = contractMode
      ? await buildUnsignedEscrowDeposit({
          contractId: campaign.escrow_contract_id,
          fromAddress: sender_public_key,
          amount: Math.floor(parseFloat(amount) * STELLAR_ASSET_DECIMALS_SCALE),
        })
      : intent.kind === 'payment'
        ? await buildUnsignedContributionPayment({
            senderPublicKey: sender_public_key,
            destinationPublicKey: campaign.wallet_public_key,
            asset: send_asset,
            amount,
            memo,
          })
        : await buildUnsignedContributionPathPayment({
            senderPublicKey: sender_public_key,
            destinationPublicKey: campaign.wallet_public_key,
            sendAsset: send_asset,
            sendMax: intent.sendMax,
            destAmount: amount,
            destAssetCode: campaign.asset_type,
            memo,
          });

    const prepareToken = createPreparedContributionToken({
      user_id: req.user.userId,
      campaign_id,
      sender_public_key,
      unsigned_xdr: unsignedXdr,
      flow_metadata: {
        ...withReferralMetadata(intent.flowMetadata, campaign_id, req),
        ip_address: req.ip,
        device_fingerprint: hashDeviceFingerprint(req.body.device_fingerprint),
        contract_mode: contractMode,
        ...(affiliateLink
          ? { referral_link_id: affiliateLink.id, referral_link_code: affiliateLink.code }
          : {}),
      },
      conversion_quote: intent.conversionQuote,
      reservation_id: reservation.id,
      amount: String(amount),
    });

    res.json({
      unsigned_xdr: unsignedXdr,
      prepare_token: prepareToken,
      conversion_quote: intent.conversionQuote,
      sender_public_key,
      network_passphrase: networkPassphrase,
      network_name: isTestnet ? 'TESTNET' : 'PUBLIC',
    });
  } catch (err) {
    await db.query(`UPDATE stellar_transactions SET status = 'failed', updated_at = NOW() WHERE id = $1`, [reservation.id]).catch((updateErr) => {
      logger.warn('Failed to release contribution reservation after prepare error', { error: updateErr.message });
    });

    if (err.statusCode === 422) {
      return res.status(422).json({ error: err.message });
    }

    logger.error('Freighter contribution preparation failed', { campaign_id, error: err.message });
    return res.status(503).json({
      error: 'Could not prepare the Stellar transaction right now. Please try again.',
    });
  }
}));

router.post('/submit-signed', requireAuth, asyncHandler(async (req, res) => {
  try {
    await assertUserKycVerified(req.user.userId);
  } catch (err) {
    const handled = handleKycGateError(res, err);
    if (handled) return handled;
  }

  const { signed_xdr, prepare_token } = req.body;
  if (!signed_xdr || !prepare_token) {
    return res.status(400).json({ error: 'signed_xdr and prepare_token are required' });
  }

  let prepared;
  try {
    prepared = verifyPreparedContributionToken(prepare_token);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Invalid prepare_token' });
  }

  if (prepared.user_id !== req.user.userId) {
    return res.status(403).json({ error: 'Prepared contribution token does not belong to this user' });
  }

  try {
    validateSubmittedContributionXdr({
      signedXdr: signed_xdr,
      unsignedXdr: prepared.unsigned_xdr,
      senderPublicKey: prepared.sender_public_key,
    });
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  // Re-check campaign status and cap exposure atomically, immediately before
  // broadcast — this is the last point the app can still say no, since a
  // stale prepare_token would otherwise let a submit slip past the cap
  // check that ran back at /prepare time (issue #713).
  const lockClient = await db.connect();
  let lockStarted = false;
  try {
    await lockClient.query('BEGIN');
    lockStarted = true;
    await lockClient.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [String(prepared.campaign_id), String(prepared.sender_public_key)]
    );

    const { rows: reservationRows } = await lockClient.query(
      `SELECT id, status, amount, expires_at FROM stellar_transactions WHERE id = $1 AND kind = 'contribution'`,
      [prepared.reservation_id]
    );
    const reservationRow = reservationRows[0];
    if (
      !reservationRow ||
      reservationRow.status !== 'reserved' ||
      (reservationRow.expires_at && new Date(reservationRow.expires_at) < new Date())
    ) {
      await lockClient.query('ROLLBACK');
      lockStarted = false;
      return res.status(410).json({
        error: 'This prepared contribution has expired or was already used. Please prepare a new contribution.',
      });
    }

    const { rows: campaignRows } = await lockClient.query(
      'SELECT status, max_contribution, max_per_user, asset_type FROM campaigns WHERE id = $1',
      [prepared.campaign_id]
    );
    if (!campaignRows.length || !['active', 'funded'].includes(campaignRows[0].status)) {
      await lockClient.query(`UPDATE stellar_transactions SET status = 'failed', updated_at = NOW() WHERE id = $1`, [prepared.reservation_id]);
      await lockClient.query('COMMIT');
      lockStarted = false;
      return res.status(409).json({ error: 'This campaign is no longer accepting contributions.' });
    }
    const campaignRow = campaignRows[0];

    const exposure = await sumContributionCapExposure(lockClient, {
      campaignId: prepared.campaign_id,
      senderPublicKey: prepared.sender_public_key,
      excludeReservationId: prepared.reservation_id,
    });
    const prospectiveTotal = exposure + parseFloat(reservationRow.amount);
    const exceedsCap =
      (campaignRow.max_contribution && prospectiveTotal > parseFloat(campaignRow.max_contribution)) ||
      (campaignRow.max_per_user && prospectiveTotal > parseFloat(campaignRow.max_per_user));
    if (exceedsCap) {
      await lockClient.query(`UPDATE stellar_transactions SET status = 'failed', updated_at = NOW() WHERE id = $1`, [prepared.reservation_id]);
      await lockClient.query('COMMIT');
      lockStarted = false;
      return res.status(400).json({
        error: 'This contribution would exceed the campaign limit. Please prepare a new, smaller contribution.',
      });
    }

    await lockClient.query(`UPDATE stellar_transactions SET status = 'submitted', updated_at = NOW() WHERE id = $1`, [prepared.reservation_id]);
    await lockClient.query('COMMIT');
    lockStarted = false;
  } catch (err) {
    if (lockStarted) {
      try {
        await lockClient.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.warn('Contribution submit-signed lock rollback failed', { error: rollbackErr.message });
      }
    }
    throw err;
  } finally {
    lockClient.release();
  }

  let txHash;
  try {
    txHash = await submitPreparedTransaction(signed_xdr);
  } catch (err) {
    await db.query(`UPDATE stellar_transactions SET status = 'failed', updated_at = NOW() WHERE id = $1`, [prepared.reservation_id]).catch(() => {});
    logger.error('Freighter contribution submission failed', {
      campaign_id: prepared.campaign_id,
      error: err.message,
    });
    sendAlert('Freighter contribution submission failed', {
      campaign_id: prepared.campaign_id,
      error: err.message,
    });
    return res.status(502).json({
      error: 'Stellar network rejected the transaction',
      detail: err.message || String(err),
    });
  }

  const { rows: finalizedRows } = await db.query(
    `UPDATE stellar_transactions
     SET tx_hash = $1, unsigned_xdr = $2, signed_xdr = $3, metadata = $4::jsonb, updated_at = NOW()
     WHERE id = $5
     RETURNING id`,
    [txHash, prepared.unsigned_xdr, signed_xdr, JSON.stringify(prepared.flow_metadata || {}), prepared.reservation_id]
  );
  const stellarTransactionId = finalizedRows[0]?.id;

  if (prepared.flow_metadata?.contract_mode) {
    // Contract-mode deposits never appear in the classic Horizon payment
    // stream ledgerMonitor watches — finalize accounting synchronously.
    try {
      await recordConfirmedContribution({
        campaignId: prepared.campaign_id,
        walletPublicKey: null,
        senderPublicKey: prepared.sender_public_key,
        destinationAmount: parseFloat(prepared.amount),
        destinationAsset: prepared.flow_metadata.send_asset,
        paymentType: 'contract_deposit',
        txHash,
      });
    } catch (recordErr) {
      logger.error('Failed to record contract-mode contribution', {
        campaign_id: prepared.campaign_id,
        tx_hash: txHash,
        error: recordErr.message,
      });
      sendAlert('Contract-mode contribution recording failed', {
        campaign_id: prepared.campaign_id,
        tx_hash: txHash,
        error: recordErr.message,
      });
    }
  }

  res.status(202).json({
    tx_hash: txHash,
    stellar_transaction_id: stellarTransactionId,
    message: 'Transaction submitted',
    conversion_quote: prepared.conversion_quote || null,
    nft_reward: Boolean(prepared.flow_metadata?.tier_id),
  });
}));

async function assertUserWalletFunded(userId) {
  const { rows } = await db.query(
    'SELECT wallet_type, wallet_public_key, wallet_funded_at, wallet_funding_failed_at FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length) return;

  const user = rows[0];
  if (user.wallet_type === 'freighter') return;

  if (user.wallet_funded_at) return;

  if (user.wallet_public_key) {
    const onLedger = await accountExistsOnLedger(user.wallet_public_key);
    if (onLedger) {
      await db.query(
        'UPDATE users SET wallet_funded_at = NOW(), wallet_funding_failed_at = NULL WHERE id = $1',
        [userId]
      );
      return;
    }
  }

  const err = new Error('Your wallet has not been funded yet. Please retry wallet funding or add funds before contributing.');
  err.statusCode = 400;
  err.code = 'WALLET_NOT_FUNDED';
  throw err;
}

router.post('/', contributionPostLimiter, requireAuth, contributionValidation, validateRequest, asyncHandler(async (req, res) => {
  try {
    await assertUserKycVerified(req.user.userId);
  } catch (err) {
    const handled = handleKycGateError(res, err);
    if (handled) return handled;
  }

  try {
    await assertUserWalletFunded(req.user.userId);
  } catch (err) {
    if (err.code === 'WALLET_NOT_FUNDED') {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const { campaign_id, amount, send_asset, display_name, tier_id } = req.body;

  if (await campaignIsDisputed(campaign_id)) {
    return res.status(409).json({
      error: 'This campaign has an open dispute and cannot accept new contributions',
      code: ERROR_CODES.CAMPAIGN_DISPUTED,
    });
  }
  const campaign = await loadActiveCampaign(campaign_id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.migration_in_progress) {
    return res.status(503).json({
      error: 'Contributions are temporarily paused while this campaign\'s contract is being upgraded',
      code: 'CAMPAIGN_MIGRATION_IN_PROGRESS',
    });
  }

  const { rows: users } = await db.query(
    'SELECT wallet_secret_encrypted, wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const contributorPublicKey = users[0].wallet_public_key;

  // Contributor requirements gate (#689)
  try {
    await assertContributorMeetsRequirements(contributorPublicKey, campaign_id);
  } catch (err) {
    if (err.code === 'CONTRIBUTOR_REQUIREMENTS_NOT_MET') {
      return res.status(403).json({
        error: err.message,
        code: err.code,
        missing: err.missing,
      });
    }
    throw err;
  }

  if (campaign.min_contribution && parseFloat(amount) < parseFloat(campaign.min_contribution)) {
    return res.status(400).json({
      error: `Minimum contribution is ${campaign.min_contribution} ${campaign.asset_type}`,
    });
  }

  if (campaign.max_contribution && parseFloat(amount) > parseFloat(campaign.max_contribution)) {
    return res.status(400).json({
      error: `Maximum contribution is ${campaign.max_contribution} ${campaign.asset_type}`,
    });
  }

  let affiliateLink;
  try {
    affiliateLink = await resolveAffiliateLink(campaign_id, req);
  } catch (err) {
    const handled = respondInvalidReferralCode(res, err);
    if (handled) return handled;
    throw err;
  }

  // If a specific reward tier was chosen, validate it exists and belongs to this campaign
  if (tier_id) {
    const { rows: tierRows } = await db.query(
      'SELECT id, title, tier_limit, claimed_count FROM reward_tiers WHERE id = $1 AND campaign_id = $2',
      [tier_id, campaign_id]
    );
    if (!tierRows.length) {
      return res.status(404).json({ error: 'Reward tier not found for this campaign' });
    }
  }

  const client = await db.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [String(campaign_id), String(contributorPublicKey)]
    );

    if (campaign.max_per_user) {
      // Includes any not-yet-indexed self-custody (Freighter) reservation/
      // submission for this same (campaign, contributor) so the two flows
      // can't be combined to exceed the cap (issue #713).
      const alreadyContributed = await sumContributionCapExposure(client, {
        campaignId: campaign_id,
        senderPublicKey: contributorPublicKey,
      });
      if (alreadyContributed + parseFloat(amount) > parseFloat(campaign.max_per_user)) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(400).json({
          error: `You have already contributed ${alreadyContributed} ${campaign.asset_type}. The per-contributor limit is ${campaign.max_per_user}.`,
        });
      }
    }

    // Atomically reserve a reward tier slot (if a tier was selected)
    let reservedTier = null;
    if (tier_id) {
      reservedTier = await reserveTierSlot(client, { tierId: tier_id, campaignId: campaign_id });
      if (!reservedTier) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(409).json({
          error: 'This reward tier is sold out',
          tier_id,
        });
      }
    }

    const result = await submitCustodialContribution({
      campaign,
      campaignId: campaign_id,
      userId: req.user.userId,
      walletPublicKey: contributorPublicKey,
      walletSecretEncrypted: users[0].wallet_secret_encrypted,
      amount,
      sendAsset: send_asset,
      displayName: display_name,
      referralCode: getReferralCodeFromRequest(campaign_id, req),
      referralLinkId: affiliateLink?.id || null,
      referralLinkCode: affiliateLink?.code || null,
      ipAddress: req.ip,
      deviceFingerprint: hashDeviceFingerprint(req.body.device_fingerprint),
      client,
      tierId: reservedTier ? reservedTier.id : null,
    });
    await client.query('COMMIT');
    transactionStarted = false;

    if (result.contractMode) {
      // Contract-mode deposits never appear in the classic Horizon payment
      // stream ledgerMonitor watches, so finalize accounting here — now that
      // the stellar_transactions row above is committed and visible. Runs
      // after commit, not inside the transaction: recordConfirmedContribution
      // opens its own connection and must never race an open outer transaction.
      try {
        await recordConfirmedContribution({
          campaignId: campaign_id,
          walletPublicKey: campaign.escrow_contract_id,
          senderPublicKey: contributorPublicKey,
          destinationAmount: result.destinationAmount,
          destinationAsset: result.destinationAsset,
          paymentType: 'contract_deposit',
          txHash: result.txHash,
        });
      } catch (recordErr) {
        logger.error('Failed to record contract-mode contribution', {
          campaign_id,
          tx_hash: result.txHash,
          error: recordErr.message,
        });
        sendAlert('Contract-mode contribution recording failed', {
          campaign_id,
          tx_hash: result.txHash,
          error: recordErr.message,
        });
      }
    }

    res.status(202).json({
      tx_hash: result.txHash,
      stellar_transaction_id: result.stellarTransactionId,
      message: "Transaction submitted",
      conversion_quote: result.conversionQuote,
      nft_reward: Boolean(tier_id),
      ...(result.platform_fee_amount !== null && result.platform_fee_amount !== undefined
        ? { platform_fee_amount: result.platform_fee_amount }
        : {}),
    });
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.warn('Contribution transaction rollback failed', { error: rollbackErr.message });
      }
      transactionStarted = false;
    }
    if (err.statusCode === 422) {
      return res.status(422).json({ error: err.message });
    }
    if (err.statusCode === 502) {
      logger.error("Stellar transaction submission failed", {
        campaign_id,
        error: err.message,
      });
      sendAlert("Stellar transaction submission failed", {
        campaign_id,
        error: err.message,
      });
      return res.status(502).json({
        error: "Stellar network rejected the transaction",
        detail: err.message || String(err),
      });
    }

    logger.error("Custodial contribution signing failed", {
      campaign_id,
      error: err.message,
    });
    return res.status(503).json({
      error: "Wallet setup is still completing; please retry in a few seconds.",
    });
  } finally {
    if (client?.release) {
      await client.release();
    }
  }

  if (Number(campaign.raised_amount) + Number(amount) >= Number(campaign.target_amount)) {
    sendEmail({
      to: campaign.creator_email,
      subject: `Target Reached for ${campaign.title}!`,
      text: `Congratulations! Your campaign "${campaign.title}" has reached its target of ${campaign.target_amount} ${campaign.asset_type}. You can now start the withdrawal process.`
    });
  }
}));

/**
 * POST /api/contributions/:id/refund
 *
 * Request a refund for a contribution via the on-chain escrow contract.
 *
 * Refund eligibility:
 *   - The requester must be the contributor who made the contribution, or an admin.
 *   - The associated campaign must be in the `failed` status. Refunds are never
 *     available for `active`, `funded`, or `closed` campaigns.
 *   - The contribution must not have already been refunded.
 *   - The campaign must have a deployed escrow contract.
 *
 * Request body:
 *   { signer_secret?: string } — optional override; defaults to platform key
 */
router.post('/:id/refund', requireAuth, asyncHandler(async (req, res) => {
  const contributionId = req.params.id;
  const signerSecret = req.body.signer_secret || process.env.PLATFORM_SECRET_KEY;

  const { rows: contributions } = await db.query(
    `SELECT ct.*, c.escrow_contract_id, c.status AS campaign_status, c.deadline, c.creator_id
     FROM contributions ct
     JOIN campaigns c ON c.id = ct.campaign_id
     WHERE ct.id = $1`,
    [contributionId]
  );

  if (!contributions.length) {
    return res.status(404).json({ error: 'Contribution not found' });
  }

  const contribution = contributions[0];

  const { rows: users } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );

  const userPublicKey = users[0]?.wallet_public_key;
  const isOwner = contribution.sender_public_key === userPublicKey;
  const isPlatform = req.user.role === 'admin';

  if (!isOwner && !isPlatform) {
    return res.status(403).json({ error: 'You can only refund your own contributions' });
  }

  if (contribution.campaign_status !== 'failed') {
    return res.status(400).json({
      error: 'Refunds are only available for failed campaigns',
      eligibility: 'A contribution is refundable only when its campaign status is "failed" and it has not already been refunded.',
      campaign_status: contribution.campaign_status,
    });
  }

  if (contribution.contract_refunded_at || contribution.contract_refund_tx_hash) {
    return res.status(409).json({
      error: 'This contribution has already been refunded',
      refunded_at: contribution.contract_refunded_at,
      tx_hash: contribution.contract_refund_tx_hash,
    });
  }

  if (!contribution.escrow_contract_id) {
    return res.status(400).json({ error: 'Campaign does not have an escrow contract deployed' });
  }

  try {
    const result = await triggerRefund({
      escrowContractId: contribution.escrow_contract_id,
      contributorAddress: contribution.sender_public_key,
      signerSecret,
    });

    await db.query(
      `UPDATE contributions
       SET contract_refund_tx_hash = $1, contract_refunded_at = NOW()
       WHERE id = $2`,
      [result?.toString() || null, contributionId]
    );

    logger.info('Contract refund processed', {
      contributionId,
      escrowContractId: contribution.escrow_contract_id,
      result,
    });

    setImmediate(() => {
      const refundPayload = {
        campaign_id: contribution.campaign_id,
        contribution_id: contribution.id,
        amount: String(contribution.amount),
        asset: contribution.asset,
        tx_hash: result?.toString() || null,
        timestamp: new Date().toISOString(),
      };
      emitWebhookEventForUser(contribution.creator_id, WEBHOOK_EVENTS.CONTRIBUTION_REFUNDED, refundPayload).catch(
        (err) => logger.error('Contribution refunded webhook emit failed', { error: err.message })
      );
      emitWebhookEventForCampaign(contribution.campaign_id, WEBHOOK_EVENTS.CONTRIBUTION_REFUNDED, refundPayload).catch(
        (err) => logger.error('Contribution refunded webhook emit failed', { error: err.message })
      );
    });

    res.json({
      message: 'Refund processed via escrow contract',
      tx_hash: result?.toString() || null,
    });
  } catch (err) {
    logger.error('Contract refund failed', {
      contributionId,
      escrowContractId: contribution.escrow_contract_id,
      error: err.message,
    });
    res.status(502).json({
      error: 'Escrow contract refund failed',
      detail: err.message,
    });
  }
}));

module.exports = router;
