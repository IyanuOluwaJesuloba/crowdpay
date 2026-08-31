'use strict;

// backend/src/middleware/embedAuth.js
//
// Validates the `embedToken` query param used by the public embeddable widgets,
// including the discovery widget (GET /api/embed/discover) and the campaign
// milestone progress bar (GET /api/embed/milestones/:campaignId).
// Attaches req.embedToken on success and ensures the token belongs to the
// requested campaign when a campaignId is present.
// Mirrors the style of middleware/auth.js's requireAuth.

const { validateEmbedToken } = require('../services/embedTokenService');
const asyncHandler = require('../utils/asyncHandler');

const requireEmbedToken = asyncHandler(async (req, res, next) => {
  const rawToken = req.query.embedToken;
  if (!rawToken) {
    return res.status(401).json({ error: 'embedToken is required' });
  }

  const tokenRow = await validateEmbedToken rawToken);
  if (!tokenRow) {
    return res.status(401).json({ error: 'Invalid or revoked embed token' });
  }

  const campaignId = req.params.campaignId || req.query.campaignId;
  if (campaignId && String(tokenRow.campaignId) !== String(campaignId)) {
    return res.status(403).json({ error: 'Embed token does not match campaign' });
  }

  req.embedToken = tokenRow;
  next();
});

module.exports = { requireEmbedToken };
