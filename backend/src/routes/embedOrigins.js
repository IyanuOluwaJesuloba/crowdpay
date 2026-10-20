'use strict';

/**
 * Campaign embed allowed-origins management (#1063).
 *
 * Mounted at /api/campaigns so origins live next to the campaign they govern:
 *
 *   GET  /api/campaigns/:id/embed/origins   — list approved origins
 *   PUT  /api/campaigns/:id/embed/origins   — replace the full list (owner only)
 *
 * Both endpoints require the authenticated user to be the campaign creator or
 * a platform admin.
 *
 * ## Representation
 *
 * Origins are stored in `campaign_embed_allowed_origins` as normalised strings
 * (lowercase, scheme + host + optional non-default port, no trailing slash).
 * The special value `"*"` may appear exactly once to opt a campaign into
 * wildcard access.  It is stored explicitly so owners can audit their choice.
 *
 * ## API contract
 *
 *   PUT body: { origins: string[] }
 *     - 1–10 entries (or exactly ["*"] for wildcard)
 *     - Each entry is validated and normalised before storage
 *     - The PUT replaces the entire list atomically (delete-then-insert)
 *
 *   Response: { origins: string[] }   — the stored normalised list
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { validateAndNormaliseAllowedOrigin } = require('../utils/originPolicy');

const MAX_ORIGINS_PER_CAMPAIGN = 10;

/**
 * Verify the authenticated user owns the campaign.
 * Used as route-level middleware before both GET and PUT.
 */
async function requireCampaignOwner(req, res, next) {
  const { id: campaignId } = req.params;
  const { rows } = await db.query(
    `SELECT creator_id FROM campaigns WHERE id = $1 AND deleted_at IS NULL`,
    [campaignId]
  );
  if (!rows.length) {
    return res.status(404).json({ error: 'Campaign not found' });
  }
  const isOwner = rows[0].creator_id === req.user.userId;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'Only the campaign owner can manage embed origins' });
  }
  req.campaignId = campaignId;
  next();
}

/**
 * GET /api/campaigns/:id/embed/origins
 * Returns the campaign's current embed origin allowlist.
 *
 * @openapi
 * /api/campaigns/{id}/embed/origins:
 *   get:
 *     summary: Get campaign embed allowed origins
 *     tags:
 *       - Embed
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: >
 *           The campaign's embed origin allowlist.  Each entry is a normalised
 *           origin string ("https://app.example.com") or the wildcard "*".
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 origins:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not the campaign owner
 *       404:
 *         description: Campaign not found
 */
router.get(
  '/:id/embed/origins',
  requireAuth,
  asyncHandler(requireCampaignOwner),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT origin FROM campaign_embed_allowed_origins
       WHERE campaign_id = $1
       ORDER BY created_at ASC`,
      [req.campaignId]
    );
    res.json({ origins: rows.map(r => r.origin) });
  })
);

/**
 * PUT /api/campaigns/:id/embed/origins
 * Replace the campaign's embed origin allowlist atomically.
 *
 * @openapi
 * /api/campaigns/{id}/embed/origins:
 *   put:
 *     summary: Set campaign embed allowed origins
 *     tags:
 *       - Embed
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
 *             required: [origins]
 *             properties:
 *               origins:
 *                 type: array
 *                 description: >
 *                   Approved embed origins as absolute URL origins
 *                   (scheme + host + optional non-default port), e.g.
 *                   "https://app.example.com" or "http://localhost:3000".
 *                   Use ["*"] to allow any origin (not recommended for
 *                   production).  Send [] to clear the allowlist (denies all
 *                   browser origins).  At most 10 entries.
 *                 items:
 *                   type: string
 *                 example: ["https://app.example.com", "https://www.example.com"]
 *     responses:
 *       200:
 *         description: >
 *           Allowlist replaced.  Returns the stored, normalised entries.
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not the campaign owner
 *       404:
 *         description: Campaign not found
 */
router.put(
  '/:id/embed/origins',
  requireAuth,
  asyncHandler(requireCampaignOwner),
  asyncHandler(async (req, res) => {
    const { origins } = req.body;

    if (!Array.isArray(origins)) {
      return res.status(400).json({ error: '"origins" must be an array' });
    }
    if (origins.length > MAX_ORIGINS_PER_CAMPAIGN) {
      return res
        .status(400)
        .json({ error: `At most ${MAX_ORIGINS_PER_CAMPAIGN} origins are allowed per campaign` });
    }

    // Validate and normalise every entry at the boundary — malformed input
    // returns 400 before any DB write.
    const normalised = [];
    for (const raw of origins) {
      if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'Each origin must be a string' });
      }
      try {
        normalised.push(validateAndNormaliseAllowedOrigin(raw));
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    // Deduplicate while preserving insertion order.
    const unique = [...new Set(normalised)];

    // Replace atomically: delete all current entries then re-insert.
    await db.query(
      `DELETE FROM campaign_embed_allowed_origins WHERE campaign_id = $1`,
      [req.campaignId]
    );

    if (unique.length > 0) {
      // Build a parameterised multi-row INSERT.
      const placeholders = unique.map((_, i) => `($1, $${i + 2})`).join(', ');
      await db.query(
        `INSERT INTO campaign_embed_allowed_origins (campaign_id, origin)
         VALUES ${placeholders}`,
        [req.campaignId, ...unique]
      );
    }

    res.json({ origins: unique });
  })
);

module.exports = router;
