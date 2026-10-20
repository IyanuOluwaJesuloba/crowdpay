const express = require('express');
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { body, param, validationResult } = require('express-validator');
const {
  createMatchingPledge,
  getCampaignMatchProgress,
  completeMatchingPledge,
  getSponsorMatchingPledges,
  DuplicateMatchingPledgeError,
} = require('../services/sponsorMatchingService');
const { logAuditEvent } = require('../services/auditService');
const { emitWebhookEventForCampaign, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { toStroops, fromStroops } = require('../utils/stroops');

/**
 * Campaign-scoped sponsor matching routes.
 * Mounted at `/api/campaigns` so pledges live next to the campaign they fund.
 */
const campaignRouter = express.Router();

/**
 * User-scoped sponsor matching routes.
 * Mounted at `/api` and resolves to `/api/user/sponsor-matches`.
 */
const userRouter = express.Router();

const MAX_MATCH_RATIO = 100;
// Maximum pledge in Stellar asset units. Stellar's int64 stroop limit is
// 922337203685.4775807 — cap well below that so validation errors are
// user-facing rather than a DB overflow or stroop overflow.
// Stored and compared as a decimal string, never a JS float.
const MAX_PLEDGE_AMOUNT_STR = '500000000000'; // 5 × 10^11, ~54% of Stellar max

function respondValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

function runAudit(payload) {
  return logAuditEvent(payload).catch(err =>
    logger.warn('Sponsor matching audit log failed', { error: err.message })
  );
}

/**
 * @openapi
 * tags:
 *   - name: Sponsor Matching
 *     description: Sponsor matching pools and pledge management
 */

/**
 * POST /api/campaigns/:id/matches
 * Create a new sponsor matching pledge for a campaign.
 *
 * @openapi
 * /api/campaigns/{id}/matches:
 *   post:
 *     summary: Create sponsor matching pledge
 *     tags:
 *       - Sponsor Matching
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [match_ratio, pledge_amount]
 *             properties:
 *               match_ratio:
 *                 type: number
 *                 description: Match multiplier, e.g. 1 for 1:1, 2 for 2:1
 *                 example: 1
 *               pledge_amount:
 *                 type: string
 *                 description: >
 *                   Total matching pool in the campaign asset, expressed as a
 *                   decimal string with at most 7 fractional digits (Stellar
 *                   precision).  The value is stored and returned in this same
 *                   canonical form ("1000.0000000") so callers never need to
 *                   parse a floating-point number.
 *                 example: "1000.0000000"
 *     responses:
 *       201:
 *         description: >
 *           Matching pledge created.  All monetary fields in the response
 *           (pledge_amount, matched_amount) are canonical 7-decimal strings.
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Campaign not found
 *       409:
 *         description: Sponsor already has an active pledge for this campaign
 */
campaignRouter.post(
  '/:id/matches',
  requireAuth,
  param('id').isUUID(),
  body('match_ratio').isFloat({ gt: 0, max: MAX_MATCH_RATIO }).toFloat(),
  // pledge_amount is kept as a string — toStroops validates and normalises it
  // inside createMatchingPledge.  We only do a cheap structural check here so
  // that obviously bad input (empty, non-numeric, negative) returns 400 before
  // we hit the service.
  body('pledge_amount')
    .isString()
    .notEmpty()
    .matches(/^[0-9]+(\.[0-9]+)?$/)
    .withMessage('pledge_amount must be a positive decimal string')
    .custom(value => {
      const { toStroops: _ts } = require('../utils/stroops');
      _ts(value); // throws AmountError if zero, negative, too-precise, or too-large
      return true;
    }),
  asyncHandler(async (req, res) => {
    if (respondValidationErrors(req, res)) return;

    const campaignId = req.params.id;
    const { match_ratio: matchRatio, pledge_amount: pledgeAmount } = req.body;
    // pledgeAmount is a validated decimal string; matchRatio is a JS float
    // (match_ratio has at most 2 DB decimal places and is not monetary — it is
    // safe to keep as a number for the INSERT column).

    // Verify campaign exists and is still open to sponsorship
    const { rows: campaigns } = await db.query(
      `SELECT id, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL`,
      [campaignId]
    );
    if (!campaigns.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (['completed', 'withdrawn', 'failed', 'refunded'].includes(campaigns[0].status)) {
      return res.status(409).json({
        error: 'Campaign is not accepting sponsor matching pledges',
        code: 'CAMPAIGN_NOT_MATCHABLE',
      });
    }

    let pledge;
    try {
      pledge = await createMatchingPledge({
        campaignId,
        sponsorUserId: req.user.userId,
        matchRatio,
        pledgeAmount,
      });
    } catch (err) {
      if (err instanceof DuplicateMatchingPledgeError || err.code === 'DUPLICATE_MATCHING_PLEDGE') {
        return res.status(409).json({
          error: err.message,
          code: 'DUPLICATE_MATCHING_PLEDGE',
        });
      }
      logger.error('Failed to create matching pledge', { error: err.message, campaignId });
      return res.status(400).json({ error: err.message });
    }

    await runAudit({
      actorId: req.user.userId,
      action: 'sponsor_match.created',
      resourceType: 'campaign_match',
      resourceId: pledge.id,
      metadata: {
        campaign_id: campaignId,
        match_ratio: pledge.match_ratio,
        pledge_amount: pledge.pledge_amount,
      },
      req,
    });

    // Emit webhook
    emitWebhookEventForCampaign(campaignId, WEBHOOK_EVENTS.SPONSOR_MATCH_CREATED, {
      match_id: pledge.id,
      sponsor_user_id: pledge.sponsor_user_id,
      match_ratio: pledge.match_ratio,
      pledge_amount: pledge.pledge_amount,
    }).catch(err => logger.error('Webhook emit failed', { err }));

    res.status(201).json(pledge);
  })
);

/**
 * GET /api/campaigns/:id/matches
 * Get sponsor matching progress for a campaign. Public: returns only aggregated
 * pool data, never sponsor identifiers.
 *
 * @openapi
 * /api/campaigns/{id}/matches:
 *   get:
 *     summary: Get campaign matching progress
 *     tags:
 *       - Sponsor Matching
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: >
 *           Matching progress data.  All monetary fields (pledgeAmount,
 *           matchedAmount, remainingAmount, totalPledged, totalMatched,
 *           remainingPoolAmount) are canonical 7-decimal strings.
 *           percentageUsed is a string formatted as "xx.xx".
 *       404:
 *         description: Campaign not found
 */
campaignRouter.get(
  '/:id/matches',
  param('id').isUUID(),
  asyncHandler(async (req, res) => {
    if (respondValidationErrors(req, res)) return;

    const campaignId = req.params.id;

    // Verify campaign exists
    const { rows: campaigns } = await db.query(
      `SELECT id FROM campaigns WHERE id = $1 AND deleted_at IS NULL`,
      [campaignId]
    );
    if (!campaigns.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    try {
      const progress = await getCampaignMatchProgress(campaignId);
      res.json(progress);
    } catch (err) {
      logger.error('Failed to get matching progress', { error: err.message, campaignId });
      res.status(500).json({ error: 'Failed to retrieve matching progress' });
    }
  })
);

/**
 * PATCH /api/campaigns/:id/matches/:matchId/complete
 * Mark a matching pledge as completed (campaign ended).
 *
 * @openapi
 * /api/campaigns/{id}/matches/{matchId}/complete:
 *   patch:
 *     summary: Complete a matching pledge
 *     tags:
 *       - Sponsor Matching
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: matchId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Matching pledge completed
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not the sponsor or campaign creator
 *       404:
 *         description: Match not found
 */
campaignRouter.patch(
  '/:id/matches/:matchId/complete',
  requireAuth,
  param('id').isUUID(),
  param('matchId').isUUID(),
  asyncHandler(async (req, res) => {
    if (respondValidationErrors(req, res)) return;

    const { id: campaignId, matchId } = req.params;

    // Verify user is the sponsor or campaign owner
    const { rows: matches } = await db.query(
      `SELECT cm.*, c.creator_id 
       FROM campaign_matches cm
       JOIN campaigns c ON cm.campaign_id = c.id
       WHERE cm.id = $1 AND cm.campaign_id = $2 AND c.deleted_at IS NULL`,
      [matchId, campaignId]
    );

    if (!matches.length) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const match = matches[0];
    const isSponsor = match.sponsor_user_id === req.user.userId;
    const isCreator = match.creator_id === req.user.userId;

    if (!isSponsor && !isCreator) {
      return res.status(403).json({ error: 'You do not have permission to complete this pledge' });
    }

    let completed;
    try {
      completed = await completeMatchingPledge(matchId);
    } catch (err) {
      logger.error('Failed to complete matching pledge', { error: err.message, matchId });
      return res.status(409).json({ error: err.message });
    }

    await runAudit({
      actorId: req.user.userId,
      action: 'sponsor_match.completed',
      resourceType: 'campaign_match',
      resourceId: completed.id,
      metadata: {
        campaign_id: campaignId,
        pledged_amount: completed.pledge_amount,
        matched_amount: completed.matched_amount,
      },
      req,
    });

    // Emit webhook — unclaimed amount computed in BigInt stroops so the
    // subtraction is exact even for fractional amounts.
    emitWebhookEventForCampaign(campaignId, WEBHOOK_EVENTS.SPONSOR_MATCH_COMPLETED, {
      match_id: completed.id,
      sponsor_user_id: completed.sponsor_user_id,
      unclaimed_amount: fromStroops(
        toStroops(String(completed.pledge_amount), { allowZero: true }) -
          toStroops(String(completed.matched_amount), { allowZero: true })
      ),
    }).catch(err => logger.error('Webhook emit failed', { err }));

    res.json(completed);
  })
);

/**
 * GET /api/user/sponsor-matches
 * Get the authenticated sponsor's matching pledges across all campaigns.
 *
 * @openapi
 * /api/user/sponsor-matches:
 *   get:
 *     summary: Get user's sponsor matching pledges
 *     tags:
 *       - Sponsor Matching
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of matching pledges
 *       401:
 *         description: Unauthorized
 */
userRouter.get(
  '/user/sponsor-matches',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const pledges = await getSponsorMatchingPledges(req.user.userId);
      res.json({ pledges });
    } catch (err) {
      logger.error('Failed to get sponsor pledges', {
        error: err.message,
        userId: req.user.userId,
      });
      res.status(500).json({ error: 'Failed to retrieve pledges' });
    }
  })
);

module.exports = { campaignRouter, userRouter };
