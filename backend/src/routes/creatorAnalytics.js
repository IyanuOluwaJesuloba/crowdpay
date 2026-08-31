const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { getCampaignVelocity, updateCampaignVelocityAlertThreshold } = require('../services/velocityService');
const db = require('../config/database');

async function requireCampaignCreatorOrMember(req, res, next) {
  const campaignId = req.params.campaignId;
  const { rows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (rows[0].creator_id !== req.user.userId && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

router.get(
  '/campaigns/:campaignId/velocity',
  requireAuth,
  requireCampaignCreatorOrMember,
  asyncHandler(async (req, res) => {
    const data = await getCampaignVelocity(req.params.campaignId);
    res.json(data);
  })
);

router.patch(
  '/campaigns/:campaignId/velocity/threshold',
  requireAuth,
  requireCampaignCreatorOrMember,
  asyncHandler(async (req, res) => {
    const threshold = Number(req.body.threshold);
    if (isNaN(threshold) || threshold < 0) {
      return res.status(422).json({ error: 'Valid threshold is required' });
    }
    const result = await updateCampaignVelocityAlertThreshold(req.params.campaignId, threshold);
    res.json(result);
  })
);

module.exports = router;