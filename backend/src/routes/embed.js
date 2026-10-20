const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const { embedStatsLimiter } = require('../middleware/rateLimiter');
const { requireAuth } = require('../middleware/auth');
const { requireEmbedToken } = require('../middleware/embedAuth');
const { getTrendingCampaigns } = require('../services/trendingService');
const {
  signEmbedToken,
  verifyEmbedToken,
} = require('../services/embedTokenJwtService');
const { checkOrigin } = require('../utils/originPolicy');
const { evaluateCampaign } = require('../services/fraudService');
const { createNotification } = require('../services/notifications');

const DESCRIPTION_TRUNCATE_LENGTH = 140;

/**
 * Simulated (database-only) embed contributions are never allowed in production.
 * Opt in explicitly for local/test with ALLOW_EMBED_SIMULATED_CONTRIBUTIONS=true.
 * See issue #813.
 */
function isEmbedSimulationAllowed() {
  if (process.env.ALLOW_EMBED_SIMULATED_CONTRIBUTIONS === 'true') {
    return true;
  }
  return false;
}

/**
 * Build the Content-Security-Policy for the embed widget from environment
 * variables so dev/staging/self-hosted deployments work without hardcoding
 * api.crowdpay.com. The WebSocket protocol is derived from the backend URL
 * and localhost origins are only permitted in non-production environments.
 */
function buildEmbedCsp() {
  const backendUrl = new URL(process.env.BACKEND_URL || 'http://localhost:3001');
  const wsProtocol = backendUrl.protocol === 'https:' ? 'wss:' : 'ws:';

  const connectSrc = [backendUrl.host, `${wsProtocol}//${backendUrl.host}`];

  if (process.env.NODE_ENV !== 'production') {
    connectSrc.push('http://localhost:3001', 'ws://localhost:3001');
  }

  return (
    `frame-ancestors *; ` +
    `default-src 'self'; ` +
    `connect-src ${connectSrc.join(' ')}; ` +
    `script-src 'self'; ` +
    `style-src 'self'`
  );
}

function truncateDescription(description) {
  if (!description) return '';
  return description.length > DESCRIPTION_TRUNCATE_LENGTH
    ? `${description.slice(0, DESCRIPTION_TRUNCATE_LENGTH).trim()}...`
    : description;
}

const IMPACT_CACHE_TTL_MS = 60 * 1000;
const impactCache = new Map();

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function signImpactPayload(payload) {
  const privateKeyPem =
    process.env.CROWDPAY_PLATFORM_PRIVATE_KEY || process.env.PLATFORM_PRIVATE_KEY;
  if (!privateKeyPem) return null;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(canonicalize(payload));
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildImpactBadgeSvg(stats, title) {
  const total = Number(stats.total_raised) || 0;
  const average = Number(stats.average_contribution) || 0;
  const largest = Number(stats.largest_contribution) || 0;
  const formattedTotal = total.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
  const formattedAverage = average.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
  const formattedLargest = largest.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="96" viewBox="0 0 320 96" role="img" aria-label="Campaign impact">
  <rect width="320" height="96" rx="12" fill="#0f172a"/>
  <text x="16" y="22" font-family="Arial, sans-serif" font-size="13" font-weight="bold" fill="#ffffff">${escapeXml(title)}</text>
  <text x="16" y="46" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#22c55e">${escapeXml(formattedTotal)} ${escapeXml(stats.currency)}</text>
  <text x="16" y="66" font-family="Arial, sans-serif" font-size="12" fill="#cbd5e1">${escapeXml(stats.contribution_count)} contributions · avg ${escapeXml(formattedAverage)} · max ${escapeXml(formattedLargest)}</text>
  <text x="16" y="84" font-family="Arial, sans-serif" font-size="11" fill="#64748b">${escapeXml(stats.unique_contributor_count)} unique contributors · CrowdPay Verified</text>
</svg>`;
}

async function getCachedImpact(campaignId) {
  const cached = impactCache.get(campaignId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.stats;
  }

  const { rows: campaignRows } = await db.query(
    `SELECT asset_type
       FROM campaigns
      WHERE id = $1 AND deleted_at IS NULL`,
    [campaignId]
  );

  if (campaignRows.length === 0) {
    return null;
  }

  const currency = campaignRows[0].asset_type || 'USDC';

  const { rows } = await db.query(
    `WITH all_contribs AS (
       SELECT amount, 'named' AS source,
              COALESCE(NULLIF(contributor_name, ''), 'anonymous') AS contributor_key
         FROM contributions
        WHERE campaign_id = $1 AND status = 'completed'
       UNION ALL
       SELECT amount, 'embed' AS source, contributor_ip_hash AS contributor_key
         FROM embed_contributions
        WHERE campaign_id = $1
          AND COALESCE(simulated, false) = false
          AND stellar_tx_hash IS NOT NULL
          AND stellar_tx_hash NOT LIKE 'tx_%'
     )
     SELECT
       COALESCE(SUM(amount), 0)::numeric AS total_raised,
       COUNT(*)::int AS contribution_count,
       COALESCE(AVG(amount), 0)::numeric AS average_contribution,
       COALESCE(MAX(amount), 0)::numeric AS largest_contribution,
       (COUNT(DISTINCT CASE WHEN source = 'named' THEN contributor_key END)::int +
        COUNT(DISTINCT CASE WHEN source = 'embed' THEN contributor_key END)::int) AS unique_contributor_count
       FROM all_contribs`,
    [campaignId]
  );

  const row = rows[0];
  const count = Number(row.contribution_count) || 0;
  const totalRaised = Number(row.total_raised) || 0;
  const stats = {
    total_raised: totalRaised,
    contribution_count: count,
    average_contribution: count > 0 ? Number(row.average_contribution) || 0 : 0,
    largest_contribution: count > 0 ? Number(row.largest_contribution) || 0 : 0,
    unique_contributor_count: Number(row.unique_contributor_count) || 0,
    currency,
  };

  impactCache.set(campaignId, {
    stats,
    expiresAt: Date.now() + IMPACT_CACHE_TTL_MS,
  });

  return stats;
}

function extractEmbedToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (req.query && req.query.token) {
    return String(req.query.token).trim();
  }
  return null;
}

/**
 * Middleware for validating embed token & origin.
 *
 * Origin enforcement (#1063):
 *   1. Load the campaign's `campaign_embed_allowed_origins` list from the DB.
 *   2. Pass the request Origin header through checkOrigin().
 *   3. checkOrigin() handles absent headers (allow — server-to-server calls),
 *      malformed origins (deny), wildcard entries, localhost dev opt-in, and
 *      exact normalised-string matches.
 */
async function authenticateEmbedToken(req, res, next) {
  const token = extractEmbedToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Embed token required in Authorization header' });
  }

  const payload = verifyEmbedToken(token);
  if (!payload || !payload.sub) {
    return res.status(401).json({ error: 'Invalid or expired embed token' });
  }

  if (req.params.campaignId && payload.sub !== req.params.campaignId) {
    return res.status(401).json({ error: 'Embed token does not match campaign ID' });
  }

  // Load the active DB token row first — this also serves as revocation check.
  const { rows } = await db.query(
    `SELECT et.*
     FROM embed_tokens et
     WHERE et.campaign_id = $1
       AND (et.expires_at IS NULL OR et.expires_at > NOW())
     ORDER BY et.created_at DESC
     LIMIT 1`,
    [payload.sub]
  );

  if (rows.length === 0) {
    return res.status(401).json({ error: 'Embed token expired or revoked' });
  }

  const activeToken = rows[0];

  // Load the campaign-level origin allowlist.
  const { rows: originRows } = await db.query(
    `SELECT origin FROM campaign_embed_allowed_origins
     WHERE campaign_id = $1
     ORDER BY created_at ASC`,
    [payload.sub]
  );
  const allowedOrigins = originRows.map(r => r.origin);

  // Evaluate the request Origin against the campaign allowlist.
  const originHeader = req.headers.origin || req.get('origin') || null;
  const { allowed, reason } = checkOrigin(originHeader, allowedOrigins);
  if (!allowed) {
    return res.status(403).json({
      error: 'Origin not allowed for this embed token',
      code: 'ORIGIN_NOT_ALLOWED',
      reason,
    });
  }

  db.query(
    `UPDATE embed_tokens SET last_used_at = NOW(), use_count = use_count + 1 WHERE id = $1`,
    [activeToken.id]
  ).catch(() => {});

  req.embedPayload = payload;
  req.embedTokenRow = activeToken;
  next();
}

/**
 * GET /api/embed/:campaignId/stats
 * Public endpoint gated by embed token. Returns ONLY public summary fields.
 */
router.get(
  '/:campaignId/stats',
  embedStatsLimiter,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;

    const campaignQuery = await db.query(
      `SELECT id, title, description, target_amount, raised_amount, asset_type,
              status, deadline, backer_count, contribution_url
       FROM campaigns WHERE id = $1`,
      [campaignId]
    );

    if (campaignQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignQuery.rows[0];

    const contributorsQuery = await db.query(
      `SELECT id, amount, created_at, contributor_name
       FROM contributions
       WHERE campaign_id = $1 AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 5`
    );

    res.json({
      campaign,
      recentContributors: contributorsQuery.rows,
    });
  })
);

/**
 * GET /api/embed/campaigns/:campaignId
 * Public endpoint gated by embed token. Returns ONLY public summary fields.
 */
router.get(
  '/campaigns/:campaignId',
  authenticateEmbedToken,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    res.header('Access-Control-Allow-Origin', '*');
    const { rows } = await db.query(
      `SELECT id, title, description, target_amount, raised_amount, asset_type, status, deadline, backer_count, contribution_url
       FROM campaigns WHERE id = $1 AND deleted_at IS NULL`,
      [campaignId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = rows[0];
    const countRows = [{ count: campaign.backer_count || 0 }];
    const contributorsQuery = { rows: [] };

    const milestonesQuery = await db.query(
      `SELECT id, title, release_percentage, status, sort_order
       FROM milestones
       WHERE campaign_id = $1
       ORDER BY sort_order ASC`,
      [campaignId]
    );

    const target = Number(campaign.target_amount) || 0;
    const raised = Number(campaign.raised_amount) || 0;
    const progressPercentage = target > 0 ? Math.min(100, (raised / target) * 100) : 0;

    let daysRemaining = null;
    if (campaign.deadline) {
      const diff = new Date(campaign.deadline) - new Date();
      daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    const goal = Number(campaign.target_amount) || 0;
    const totalRaised = Number(campaign.raised_amount) || 0;
    const percentFunded =
      goal > 0 ? Math.min(100, Math.round((totalRaised / goal) * 1000) / 10) : 0;

    const { rows: milestoneRows } = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(completed_at)::int AS completed
       FROM campaign_milestones
       WHERE campaign_id = $1 AND deleted_at IS NULL`,
      [campaignId]
    );

    const { rows: settingsRows } = await db.query(
      `SELECT brand_color, accent_color
       FROM campaign_settings
       WHERE campaign_id = $1`,
      [campaignId]
    );

    const milestoneTotal = milestoneRows[0]?.total || 0;
    const milestoneCompleted = milestoneRows[0]?.completed || 0;
    const milestonePercent =
      milestoneTotal > 0 ? Math.round((milestoneCompleted / milestoneTotal) * 100) : 0;

    // Strict schema check: returns zero internal fields (no wallet keys, no email, no IDs)
    res.json({
      title: campaign.title,
      description: truncateDescription(campaign.description),
      goal,
      totalRaised,
      percentFunded,
      deadline: campaign.deadline,
      asset: campaign.asset_type,
      status: campaign.status,
      contributorCount: countRows[0]?.count || 0,
      milestoneProgress: {
        total: milestoneTotal,
        completed: milestoneCompleted,
        percent: milestonePercent,
      },
      branding: {
        brandColor: settingsRows[0]?.brand_color || '#2563eb',
        accentColor: settingsRows[0]?.accent_color || '#f59e0b',
      },
    });
  })
);

/**
 * GET /campaigns/:campaignId/impact
 * Public aggregate-only impact summary with optional provenance signature.
 */
router.get(
  '/campaigns/:campaignId/impact',
  embedStatsLimiter,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const stats = await getCachedImpact(campaignId);
    if (!stats) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.set('Cache-Control', 'public, max-age=60');

    if (req.query.sign === 'true' || req.query.signed === 'true') {
      const signedPayload = canonicalize(stats);
      const signature = signImpactPayload(stats);
      if (!signature) {
        return res.status(500).json({ error: 'Impact signing is not configured' });
      }
      return res.json({
        ...stats,
        signed_payload: signedPayload,
        signature,
        signature_algorithm: 'RSA-SHA256',
      });
    }

    res.json(stats);
  })
);

/**
 * GET /campaigns/:campaignId/impact-badge.svg
 * Renders a lightweight SVG impact badge for embeds and campaign pages.
 */
router.get(
  '/campaigns/:campaignId/impact-badge.svg',
  embedStatsLimiter,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const stats = await getCachedImpact(campaignId);
    if (!stats) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { rows } = await db.query(
      `SELECT title
         FROM campaigns
        WHERE id = $1 AND deleted_at IS NULL`,
      [campaignId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.set('Cache-Control', 'public, max-age=60');
    res.type('image/svg+xml');
    res.send(buildImpactBadgeSvg(stats, rows[0].title));
  })
);

/**
 * POST /api/embed/campaigns/:campaignId/contribute
 * Public contribution endpoint gated by embed token with rate limiting.
 */
router.post(
  '/campaigns/:campaignId/contribute',
  authenticateEmbedToken,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const activeToken = req.embedTokenRow;

    // Rate limiting: 10 attempts per IP per hour
    const rawIp = req.ip || req.connection?.remoteAddress || '127.0.0.1';
    const contributorIpHash = crypto.createHash('sha256').update(rawIp).digest('hex');

    const { rows: ipCheck } = await db.query(
      `SELECT COUNT(*)::int AS count FROM embed_contributions
       WHERE contributor_ip_hash = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [contributorIpHash]
    );

    if (ipCheck[0].count >= 10) {
      return res.status(429).json({ error: 'Too Many Requests' });
    }

    // Rate limiting: 100 contributions per embed token per day
    const { rows: tokenCheck } = await db.query(
      `SELECT COUNT(*)::int AS count FROM embed_contributions
       WHERE embed_token_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [activeToken.id]
    );

    if (tokenCheck[0].count >= 100) {
      return res.status(429).json({ error: 'Too Many Requests' });
    }

    const { amount, asset = 'USDC' } = req.body;
    const contribAmount = Number(amount);
    if (!contribAmount || contribAmount <= 0) {
      return res.status(400).json({ error: 'Invalid contribution amount' });
    }

    // ── Fetch campaign for validation before any mutation ─────────────────────
    const { rows: campaignFetch } = await db.query(
      `SELECT id, status, deadline, target_amount, raised_amount,
              min_contribution, max_contribution, creator_id
       FROM campaigns
       WHERE id = $1 AND deleted_at IS NULL`,
      [campaignId]
    );

    if (campaignFetch.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignFetch[0];

    // ── Campaign status check ─────────────────────────────────────────────────
    if (!['active', 'funded'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Campaign is not accepting contributions' });
    }

    // ── Deadline check ────────────────────────────────────────────────────────
    if (campaign.deadline && new Date(campaign.deadline) < new Date()) {
      return res.status(400).json({ error: 'Campaign deadline has passed' });
    }

    // ── Minimum contribution amount ───────────────────────────────────────────
    const minContrib = campaign.min_contribution ? Number(campaign.min_contribution) : null;
    if (minContrib !== null && contribAmount < minContrib) {
      return res.status(400).json({
        error: `Contribution amount is below the minimum of ${minContrib}`,
      });
    }

    // ── Maximum contribution amount ───────────────────────────────────────────
    const maxContrib = campaign.max_contribution ? Number(campaign.max_contribution) : null;
    if (maxContrib !== null && contribAmount > maxContrib) {
      return res.status(400).json({
        error: `Contribution amount exceeds the maximum of ${maxContrib}`,
      });
    }

    // ── Per-contributor IP cap ────────────────────────────────────────────────
    // Mirror the main contribution flow's max_contribution_per_user check using
    // the hashed IP as the contributor identity for anonymous embed contributions.
    if (maxContrib !== null) {
      const { rows: capCheck } = await db.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS total
         FROM embed_contributions
         WHERE campaign_id = $1 AND contributor_ip_hash = $2
           AND COALESCE(simulated, false) = false`,
        [campaignId, contributorIpHash]
      );
      const alreadyContributed = Number(capCheck[0].total);
      if (alreadyContributed + contribAmount > maxContrib) {
        return res.status(400).json({
          error: `This contribution would exceed the per-contributor limit of ${maxContrib}`,
        });
      }
    }

    // ── Fail closed: no simulated funding outside explicit allow (#813) ───────
    if (!isEmbedSimulationAllowed()) {
      const frontendBase = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || '').replace(
        /\/$/,
        ''
      );
      const contributionUrl = frontendBase
        ? `${frontendBase}/campaigns/${campaignId}`
        : `/campaigns/${campaignId}`;
      return res.status(503).json({
        error: 'Embed contributions require on-chain payment',
        code: 'EMBED_PAYMENT_REQUIRED',
        contribution_url: contributionUrl,
      });
    }

    // ── Simulated path (dev/test only) ───────────────────────────────────────
    const { rows: campaignRows } = await db.query(
      `UPDATE campaigns
       SET raised_amount = raised_amount + $1
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING raised_amount, target_amount`,
      [contribAmount, campaignId]
    );

    if (campaignRows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const stellarTxHash = 'tx_' + crypto.randomBytes(16).toString('hex');

    await db.query(
      `INSERT INTO embed_contributions
         (campaign_id, embed_token_id, amount, asset, stellar_tx_hash, contributor_ip_hash, simulated)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [campaignId, activeToken.id, contribAmount, asset, stellarTxHash, contributorIpHash]
    );

    impactCache.delete(campaignId);

    const updated = campaignRows[0];

    // ── Fraud signal evaluation (non-fatal) ───────────────────────────────────
    evaluateCampaign(campaignId).catch(() => {});

    // ── Notify campaign creator (non-fatal) ───────────────────────────────────
    if (campaign.creator_id) {
      createNotification(campaign.creator_id, {
        type: 'embed_contribution_received',
        title: 'New contribution via embed widget',
        body: `A contribution of ${contribAmount} ${asset} was received through your embed widget.`,
        link: `/campaigns/${campaignId}`,
      }).catch(() => {});
    }

    res.json({
      id: campaign.id,
      raised_amount: updated.raised_amount,
      target_amount: updated.target_amount,
      simulated: true,
      txHash: stellarTxHash,
    });
  })
);

/**
 * GET /embed/widget.html (or GET /widget.html)
 * Serves iframe widget HTML response with CSP headers.
 */
router.get(['/widget.html', '/widget'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', buildEmbedCsp());
  res.removeHeader('X-Frame-Options');

  const widgetPath = path.join(__dirname, '../../../frontend/public/embed/widget.html');
  if (fs.existsSync(widgetPath)) {
    return res.sendFile(widgetPath, {
      headers: {
        'Content-Security-Policy': buildEmbedCsp(),
      },
    });
  }

  res.send(
    `<!DOCTYPE html><html><head><title>CrowdPay Widget</title></head><body>Embed Widget</body></html>`
  );
});

/**
 * GET /embed/widget.js (or /widget.js)
 * Serves the script-tag embed loader for the milestone progress bar widget.
 */
router.get(['/widget.js', '/embed/widget.js'], (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const widgetScriptPath = path.join(__dirname, '../../../frontend/public/embed/widget.js');
  if (fs.existsSync(widgetScriptPath)) {
    return res.sendFile(widgetScriptPath);
  }

  res.send(
    `(function(){var s=document.currentScript,u=new URL(s.src);u.pathname='/widget.html';var i=document.createElement('iframe');i.src=u.toString();i.style.width='100%';i.style.border='0';i.style.overflow='hidden';s.parentNode.insertBefore(i,s);setInterval(function(){u.searchParams.set('_t',Date.now());i.src=u.toString();},60000);})();`
  );
});

// Backwards compatibility for discovery widget
router.get(
  '/discover',
  requireEmbedToken,
  asyncHandler(async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    const limit = Math.min(Math.max(Number(req.query.limit) || 3, 1), 5);
    const trending = await getTrendingCampaigns({ limit: 50 });
    const siteBaseUrl = (process.env.PUBLIC_SITE_URL || 'https://crowdpay.com').replace(/\/+$/, '');

    const campaigns = trending.slice(0, limit).map(c => ({
      id: c.id,
      title: c.title,
      description_truncated: truncateDescription(c.description),
      goalAmountUsd: Number(c.target_amount) || 0,
      totalRaisedUsd: Number(c.raised_amount) || 0,
      percentFunded:
        c.target_amount > 0 ? Math.round((c.raised_amount / c.target_amount) * 100) : 0,
      asset: c.asset_type,
      status: c.status,
      shareUrl: `${siteBaseUrl}/campaigns/${c.id}`,
    }));

    res.json({ campaigns });
  })
);

module.exports = router;
