/**
 * Campaign requirements routes — issue #689
 *
 * POST /api/campaigns/:id/requirements  — creator-only; set/update requirements
 * GET  /api/campaigns/:id/requirements  — public; read current requirements
 */

const router = require('express').Router({ mergeParams: true });
const { body, param, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const db = require('../config/database');

const VALID_ATTESTATION_TYPES = ['kyc_basic', 'kyc_standard', 'kyc_enhanced'];

function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request parameters',
        fields: Object.fromEntries(errors.array().map((e) => [e.path, e.msg])),
      },
    });
  }
  next();
}

/**
 * POST /api/campaigns/:id/requirements
 *
 * Campaign creator sets contribution requirements.  Upserts — a second call
 * replaces the previous record.
 */
router.post(
  '/:id/requirements',
  requireAuth,
  [
    param('id').isUUID().withMessage('Campaign id must be a valid UUID'),
    body('min_reputation_score')
      .optional()
      .isInt({ min: 0, max: 500 })
      .withMessage('min_reputation_score must be an integer between 0 and 500'),
    body('required_attestations')
      .optional()
      .isArray()
      .withMessage('required_attestations must be an array')
      .custom((arr) => {
        for (const item of arr) {
          if (!VALID_ATTESTATION_TYPES.includes(item)) {
            throw new Error(
              `Each attestation must be one of: ${VALID_ATTESTATION_TYPES.join(', ')}`
            );
          }
        }
        return true;
      }),
  ],
  validateRequest,
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;
    const { userId } = req.user;
    const minReputationScore = req.body.min_reputation_score ?? 0;
    const requiredAttestations = req.body.required_attestations ?? [];

    // Verify campaign ownership
    const { rows: campRows } = await db.query(
      'SELECT id, creator_id FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [campaignId]
    );
    if (!campRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campRows[0].creator_id !== userId) {
      return res.status(403).json({ error: 'Only the campaign creator can set requirements' });
    }

    const { rows } = await db.query(
      `INSERT INTO campaign_requirements
         (campaign_id, min_reputation_score, required_attestations)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (campaign_id) DO UPDATE
         SET min_reputation_score  = EXCLUDED.min_reputation_score,
             required_attestations = EXCLUDED.required_attestations,
             updated_at            = NOW()
       RETURNING *`,
      [campaignId, minReputationScore, JSON.stringify(requiredAttestations)]
    );

    res.status(200).json(rows[0]);
  })
);

/**
 * GET /api/campaigns/:id/requirements
 *
 * Public read.  Returns the current requirements for a campaign, or nulls
 * if none have been set.
 */
router.get(
  '/:id/requirements',
  [param('id').isUUID().withMessage('Campaign id must be a valid UUID')],
  validateRequest,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM campaign_requirements WHERE campaign_id = $1',
      [req.params.id]
    );
    if (!rows.length) {
      return res.json({
        campaign_id: req.params.id,
        min_reputation_score: 0,
        required_attestations: [],
      });
    }
    res.json(rows[0]);
  })
);

module.exports = router;
