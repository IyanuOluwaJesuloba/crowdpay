const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const treasury = require('../services/contractTreasury');

/**
 * Treasury endpoints hang off /api/campaigns/:id/treasury. Campaign ownership is
 * re-checked here rather than inherited, so mounting the router somewhere else
 * cannot silently drop the check.
 */
const requireCampaignOwner = asyncHandler(async (req, res, next) => {
  const campaignId = req.params.id;
  const { rows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (req.user.role !== 'admin' && rows[0].creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Only the campaign creator can do this' });
  }
  return next();
});

/** The auditor is identified by the wallet key recorded on the campaign. */
const requireAuditor = asyncHandler(async (req, res, next) => {
  const { rows } = await db.query(
    'SELECT auditor_public_key FROM campaigns WHERE id = $1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const auditorKey = rows[0].auditor_public_key;
  if (!auditorKey) {
    return res
      .status(409)
      .json({ error: 'This campaign has no auditor', code: 'AUDITOR_NOT_CONFIGURED' });
  }

  const { rows: userRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (userRows[0]?.wallet_public_key !== auditorKey) {
    return res.status(403).json({ error: 'Only the campaign auditor can do this' });
  }
  return next();
});

/** Contract rejections are already carrying their status and symbolic code. */
function sendServiceError(res, err) {
  if (err.statusCode && err.code) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  throw err;
}

/**
 * @openapi
 * /api/campaigns/{id}/treasury/policy:
 *   post:
 *     tags: [Treasury]
 *     summary: Set the Soroban treasury spending policy (creator only)
 *     description: >
 *       Only settable before the treasury contract is deployed — once deployed the
 *       on-chain policy is the one that governs and cannot be edited from here.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               minHoldDays: { type: integer, example: 30 }
 *               maxSingleWithdrawalPct: { type: integer, example: 25 }
 *               withdrawalCooldownHours: { type: integer, example: 24 }
 *               requireAuditorForAbove: { type: string, example: "5000" }
 *               autoRefundOnMiss: { type: boolean, example: true }
 *     responses:
 *       200: { description: The stored policy }
 *       400: { description: INVALID_POLICY - a field is outside its permitted range }
 *       403: { description: Not the campaign creator }
 *       409: { description: TREASURY_ALREADY_DEPLOYED or CAMPAIGN_LIVE }
 */
router.post(
  '/policy',
  requireAuth,
  requireCampaignOwner,
  asyncHandler(async (req, res) => {
    try {
      const policy = await treasury.setPolicy(req.params.id, req.body || {});
      res.json(policy);
    } catch (err) {
      sendServiceError(res, err);
    }
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/treasury/status:
 *   get:
 *     tags: [Treasury]
 *     summary: Live treasury state read from the contract
 *     description: >
 *       Reads totals, policy, pause state, and withdrawal history directly from the
 *       Soroban contract on every call — never from the database cache — so the
 *       public transparency panel shows what the contract actually enforces.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Live contract state }
 *       409: { description: NOT_CONTRACT_WALLET - the campaign uses the multisig wallet }
 *       404: { description: Campaign not found }
 */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    try {
      const status = await treasury.getTreasuryStatus(req.params.id);
      res.json(status);
    } catch (err) {
      sendServiceError(res, err);
    }
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/treasury/withdrawal:
 *   post:
 *     tags: [Treasury]
 *     summary: Request a withdrawal against the treasury policy (creator only)
 *     description: >
 *       The contract validates the hold period, the per-withdrawal ceiling, and the
 *       cooldown before anything moves. A request above requireAuditorForAbove is
 *       parked for the auditor and reported as `pending_auditor`; anything else
 *       executes immediately and comes back as `immediate`.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, destination]
 *             properties:
 *               amount: { type: string, example: "2500" }
 *               destination: { type: string, example: "GA..." }
 *               memo: { type: string, example: "tranche-1" }
 *     responses:
 *       200: { description: "{ type: immediate | pending_auditor }" }
 *       403: { description: Not the campaign creator }
 *       422: { description: "A policy constraint rejected it: HOLD_PERIOD_NOT_ELAPSED, EXCEEDS_MAX_WITHDRAWAL_PCT, COOLDOWN_NOT_ELAPSED, INSUFFICIENT_BALANCE, TREASURY_PAUSED" }
 *       501: { description: FREIGHTER_SIGNING_UNSUPPORTED - the creator's wallet is non-custodial and cannot yet sign contract calls server-side }
 */
router.post(
  '/withdrawal',
  requireAuth,
  requireCampaignOwner,
  asyncHandler(async (req, res) => {
    const { amount, destination, memo } = req.body || {};
    if (!amount || !destination) {
      return res
        .status(400)
        .json({ error: 'amount and destination are required', code: 'VALIDATION_ERROR' });
    }
    try {
      const result = await treasury.buildWithdrawalRequest(req.params.id, {
        amount: String(amount),
        destination,
        memo,
        requestedBy: req.user.userId,
      });
      return res.json(result);
    } catch (err) {
      return sendServiceError(res, err);
    }
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/treasury/withdrawal/{pendingId}/approve:
 *   post:
 *     tags: [Treasury]
 *     summary: Auditor approval that releases a parked withdrawal
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: pendingId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: The completed withdrawal }
 *       403: { description: Not the campaign auditor }
 *       404: { description: PENDING_NOT_FOUND }
 *       409: { description: AUDITOR_NOT_CONFIGURED }
 *       501: { description: FREIGHTER_SIGNING_UNSUPPORTED - the auditor's wallet is non-custodial and cannot yet sign contract calls server-side }
 */
router.post(
  '/withdrawal/:pendingId/approve',
  requireAuth,
  requireAuditor,
  asyncHandler(async (req, res) => {
    const pendingId = Number.parseInt(req.params.pendingId, 10);
    if (!Number.isInteger(pendingId) || pendingId < 1) {
      return res.status(400).json({ error: 'Invalid pending id', code: 'VALIDATION_ERROR' });
    }
    try {
      const withdrawal = await treasury.approvePendingWithdrawal(req.params.id, pendingId, {
        approverId: req.user.userId,
      });
      return res.json(withdrawal);
    } catch (err) {
      return sendServiceError(res, err);
    }
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/treasury/refund:
 *   post:
 *     tags: [Treasury]
 *     summary: Trigger the automatic refund for a missed goal
 *     description: >
 *       Callable by any authenticated user, matching the contract, so refunds do
 *       not depend on the creator or the platform choosing to act. The contract
 *       still checks the deadline, the goal, and the policy flag.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: The recorded refund event }
 *       422: { description: AUTO_REFUND_DISABLED or REFUND_CONDITIONS_NOT_MET }
 */
router.post(
  '/refund',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const event = await treasury.triggerAutoRefund(req.params.id, {
        triggeredBy: req.user.userId,
      });
      logger.info('Treasury refund endpoint invoked', {
        campaign_id: req.params.id,
        user_id: req.user.userId,
      });
      return res.json(event);
    } catch (err) {
      return sendServiceError(res, err);
    }
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/treasury/reconciliation:
 *   get:
 *     tags: [Treasury]
 *     summary: Compare on-chain withdrawal history against the database (creator only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Counts and totals from both sides plus an inSync flag }
 */
router.get(
  '/reconciliation',
  requireAuth,
  requireCampaignOwner,
  asyncHandler(async (req, res) => {
    try {
      const report = await treasury.reconcileWithdrawals(req.params.id);
      return res.json(report);
    } catch (err) {
      return sendServiceError(res, err);
    }
  })
);

module.exports = router;
