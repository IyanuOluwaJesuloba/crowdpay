const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/authScopes');
const asyncHandler = require('../utils/asyncHandler');
const { getFraudDashboard, resolveFlaggedContribution, retrainModel } = require('../services/fraudService');

router.use(requireAuth, requireAdmin);

/**
 * @openapi
 * /api/admin/fraud/dashboard:
 *   get:
 *     summary: Get fraud dashboard data
 */
router.get('/fraud/dashboard', asyncHandler(async (req, res) => {
  const status = req.query.status;
  const limit = parseInt(req.query.limit || '50', 10);
  const offset = parseInt(req.query.offset || '0', 10);

  const items = await getFraudDashboard({ status, limit, offset });
  res.json({ items });
}));

/**
 * @openapi
 * /api/admin/fraud/contributions/{id}/resolve:
 *   post:
 *     summary: Approve or reject flagged contribution
 */
router.post('/fraud/contributions/:id/resolve', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { resolution } = req.body;
  const adminUserId = req.user.userId;

  const updated = await resolveFlaggedContribution({
    contributionId: id,
    resolution,
    adminUserId,
  });

  res.json({ success: true, contribution: updated });
}));

/**
 * @openapi
 * /api/admin/fraud/retrain:
 *   post:
 *     summary: Retrain fraud scoring model
 */
router.post('/fraud/retrain', asyncHandler(async (req, res) => {
  const result = await retrainModel();
  res.json(result);
}));

module.exports = router;