'use strict';

/**
 * analyticsService.js
 *
 * Provides campaign analytics data. All query results are cached for 5 minutes
 * since analytics data changes infrequently and these 4 queries are expensive
 * (aggregations over contributions, campaigns, and milestones).
 *
 * Cache key scheme: "analytics:<campaignId>"
 * Invalidation: call invalidateCampaignAnalytics(campaignId) after a
 *               contribution is recorded or a milestone is released.
 */

const db = require('../config/database');
const { TtlCache } = require('../utils/TtlCache');

// 5-minute TTL — analytics snapshots don't need sub-minute freshness
const analyticsCache = new TtlCache(5 * 60_000);

/**
 * Get analytics for a single campaign.
 *
 * Runs 4 parallel queries:
 *   1. Contribution totals and unique backer count
 *   2. Daily contribution time series (last 30 days)
 *   3. Milestone release summary
 *   4. Asset / payment-type breakdown
 *
 * @param {string} campaignId
 * @returns {Promise<object>}
 */
async function getCachedCampaignAnalytics(campaignId) {
  const key = `analytics:${campaignId}`;
  return analyticsCache.wrap(key, async () => {
    const [totals, timeSeries, milestones, breakdown] = await Promise.all([
      // 1. Totals + unique backers
      db.query(
        `SELECT
           COUNT(*)::int                        AS total_contributions,
           COUNT(DISTINCT sender_public_key)::int AS unique_backers,
           COALESCE(SUM(amount), 0)             AS total_received,
           COALESCE(AVG(amount), 0)             AS average_contribution,
           COALESCE(MAX(amount), 0)             AS largest_contribution
         FROM contributions
         WHERE campaign_id = $1`,
        [campaignId]
      ),

      // 2. Daily time series — last 30 days
      db.query(
        `SELECT
           date_trunc('day', created_at)::date AS day,
           COUNT(*)::int                        AS count,
           COALESCE(SUM(amount), 0)             AS amount
         FROM contributions
         WHERE campaign_id = $1
           AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY 1
         ORDER BY 1`,
        [campaignId]
      ),

      // 3. Milestone release progress
      db.query(
        `SELECT
           status,
           COUNT(*)::int            AS count,
           SUM(release_percentage)  AS total_release_pct
         FROM milestones
         WHERE campaign_id = $1
         GROUP BY status`,
        [campaignId]
      ),

      // 4. Payment type and asset breakdown
      db.query(
        `SELECT
           asset,
           payment_type,
           COUNT(*)::int       AS count,
           SUM(amount)         AS total
         FROM contributions
         WHERE campaign_id = $1
         GROUP BY asset, payment_type
         ORDER BY total DESC`,
        [campaignId]
      ),
    ]);

    return {
      campaign_id: campaignId,
      totals: totals.rows[0],
      daily_series: timeSeries.rows,
      milestones: milestones.rows,
      payment_breakdown: breakdown.rows,
      generated_at: new Date().toISOString(),
    };
  });
}

/**
 * Get platform-wide analytics summary.
 * Cached for 5 minutes — this is a heavy aggregation across all campaigns.
 *
 * @returns {Promise<object>}
 */
async function getPlatformAnalytics() {
  return analyticsCache.wrap('analytics:platform', async () => {
    const [summary, topCampaigns, recentActivity, assetBreakdown] = await Promise.all([
      // 1. Platform-wide totals
      db.query(
        `SELECT
           COUNT(DISTINCT c.id)::int            AS total_campaigns,
           COUNT(DISTINCT ctr.id)::int          AS total_contributions,
           COUNT(DISTINCT ctr.sender_public_key)::int AS unique_backers,
           COALESCE(SUM(ctr.amount), 0)         AS total_raised
         FROM campaigns c
         LEFT JOIN contributions ctr ON ctr.campaign_id = c.id
         WHERE c.deleted_at IS NULL`
      ),

      // 2. Top 5 campaigns by raised_amount
      db.query(
        `SELECT id, title, raised_amount, target_amount, asset_type, status
         FROM campaigns
         WHERE deleted_at IS NULL
         ORDER BY raised_amount DESC
         LIMIT 5`
      ),

      // 3. Contributions in last 24h
      db.query(
        `SELECT
           COUNT(*)::int        AS contributions_24h,
           COALESCE(SUM(amount), 0) AS raised_24h
         FROM contributions
         WHERE created_at >= NOW() - INTERVAL '24 hours'`
      ),

      // 4. Asset breakdown across all campaigns
      db.query(
        `SELECT asset, COUNT(*)::int AS count, SUM(amount) AS total
         FROM contributions
         GROUP BY asset
         ORDER BY total DESC`
      ),
    ]);

    return {
      summary: summary.rows[0],
      top_campaigns: topCampaigns.rows,
      recent_activity: recentActivity.rows[0],
      asset_breakdown: assetBreakdown.rows,
      generated_at: new Date().toISOString(),
    };
  });
}

/**
 * Invalidate cached analytics for a specific campaign.
 * Call after a contribution is recorded for that campaign.
 * @param {string} campaignId
 */
function invalidateCampaignAnalytics(campaignId) {
  analyticsCache.invalidate(`analytics:${campaignId}`);
  analyticsCache.invalidate('analytics:platform');
}


/**
 * Daily contribution buckets for the full campaign duration.
 * Fills in zero-contribution days so charts render continuous lines.
 */
async function getCampaignAnalytics(campaignId) {
  const { rows: [campaign] } = await db.query(
    `SELECT created_at, deadline, raised_amount, target_amount, asset_type FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!campaign) return null;

  const [dailyRows, summaryRows, assetRows] = await Promise.all([
    db.query(
      `SELECT DATE(created_at) AS day,
              COUNT(*)::int     AS contribution_count,
              SUM(amount)       AS total_amount
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [campaignId]
    ),
    db.query(
      `SELECT COUNT(*)::int                           AS total_contributions,
              COUNT(DISTINCT sender_public_key)::int  AS unique_contributors,
              COALESCE(AVG(amount), 0)                AS avg_contribution,
              SUM(CASE WHEN is_recurring = TRUE THEN 1 ELSE 0 END)::int AS recurring_contributions,
              COALESCE(SUM(amount) FILTER (WHERE is_recurring = TRUE), 0) AS recurring_total
       FROM contributions
       WHERE campaign_id = $1`,
      [campaignId]
    ),
    db.query(
      `SELECT COALESCE(source_asset, asset) AS currency,
              COUNT(*)::int                  AS count,
              SUM(amount)                    AS total
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY currency
       ORDER BY total DESC`,
      [campaignId]
    ),
  ]);

  // Fill zero-contribution days across the full campaign duration
  const start = new Date(campaign.created_at);
  const end = campaign.deadline ? new Date(campaign.deadline) : new Date();
  const byDay = Object.fromEntries(dailyRows.rows.map(r => [r.day.toISOString().slice(0, 10), r]));
  const buckets = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    buckets.push(byDay[key] ?? { day: key, contribution_count: 0, total_amount: '0' });
  }

  return {
    campaign: {
      raised_amount: campaign.raised_amount,
      target_amount: campaign.target_amount,
      asset_type: campaign.asset_type,
    },
    summary: summaryRows.rows[0],
    daily_buckets: buckets,
    top_currencies: assetRows.rows,
  };
}

/**
 * Contributor breakdown: repeat vs first-time, country from user profile.
 */
async function getCampaignContributors(campaignId) {
  const [repeatRows, countryRows] = await Promise.all([
    db.query(
      `SELECT
         SUM(CASE WHEN times > 1 THEN 1 ELSE 0 END)::int AS repeat_contributors,
         SUM(CASE WHEN times = 1 THEN 1 ELSE 0 END)::int AS first_time_contributors
       FROM (
         SELECT sender_public_key, COUNT(*) AS times
         FROM contributions
         WHERE campaign_id = $1
         GROUP BY sender_public_key
       ) sub`,
      [campaignId]
    ),
    db.query(
      `SELECT COALESCE(u.country, 'Unknown') AS country,
              COUNT(DISTINCT ctr.sender_public_key)::int AS contributor_count
       FROM contributions ctr
       LEFT JOIN users u ON u.wallet_public_key = ctr.sender_public_key
       WHERE ctr.campaign_id = $1
       GROUP BY country
       ORDER BY contributor_count DESC
       LIMIT 10`,
      [campaignId]
    ),
  ]);

  return {
    ...repeatRows.rows[0],
    country_breakdown: countryRows.rows,
  };
}

async function getCampaignBackers(campaignId) {
  const [backerRows, topBackerRows] = await Promise.all([
    db.query(
      `SELECT DATE(created_at) AS day,
              COUNT(DISTINCT sender_public_key)::int AS new_backers
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [campaignId]
    ),
    db.query(
      `SELECT sender_public_key,
              COUNT(*)::int AS contribution_count,
              SUM(amount) AS total_amount
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY sender_public_key
       ORDER BY total_amount DESC, contribution_count DESC
       LIMIT 10`,
      [campaignId]
    ),
  ]);

  const totalBackers = await db.query(
    `SELECT COUNT(DISTINCT sender_public_key)::int AS total_backers
     FROM contributions
     WHERE campaign_id = $1`,
    [campaignId]
  );

  const repeatRate = await db.query(
    `SELECT
       CASE
         WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(
           SUM(CASE WHEN times > 1 THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100,
           2
         )
       END AS repeat_rate
     FROM (
       SELECT sender_public_key, COUNT(*) AS times
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY sender_public_key
     ) sub`,
    [campaignId]
  );

  return {
    total_backers: totalBackers.rows[0]?.total_backers ?? 0,
    new_backers_by_day: backerRows.rows,
    top_backers: topBackerRows.rows.map((row) => ({
      sender_public_key: row.sender_public_key,
      contribution_count: row.contribution_count,
      total_amount: row.total_amount,
    })),
    repeat_rate: Number(repeatRate.rows[0]?.repeat_rate ?? 0),
  };
}

/**
 * Aggregate analytics across all campaigns owned by a creator.
 */
async function getUserDashboardAnalytics(userId) {
  const [overviewRows, trendRows, topCampaignRows, velocityRows, retentionRows, referralRows] = await Promise.all([
    db.query(
      `SELECT
         COUNT(DISTINCT c.id)::int                                AS total_campaigns,
         COALESCE(SUM(ctr.amount), 0)                            AS total_raised,
         COUNT(ctr.id)::int                                       AS total_contributions,
         COUNT(DISTINCT ctr.sender_public_key)::int              AS unique_contributors,
         COALESCE(AVG(ctr.amount), 0)                            AS avg_contribution,
         SUM(CASE WHEN ctr.is_recurring = TRUE THEN 1 ELSE 0 END)::int AS recurring_contributions,
         COALESCE(SUM(ctr.amount) FILTER (WHERE ctr.is_recurring = TRUE), 0) AS recurring_raised
       FROM campaigns c
       LEFT JOIN contributions ctr ON ctr.campaign_id = c.id
       WHERE c.creator_id = $1`,
      [userId]
    ),
    db.query(
      `SELECT DATE(ctr.created_at) AS day,
              COUNT(*)::int         AS contribution_count,
              SUM(ctr.amount)       AS total_amount
       FROM contributions ctr
       JOIN campaigns c ON c.id = ctr.campaign_id
       WHERE c.creator_id = $1
         AND ctr.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(ctr.created_at)
       ORDER BY day ASC`,
      [userId]
    ),
    db.query(
      `SELECT c.id, c.title, c.raised_amount, c.target_amount, c.asset_type,
              COUNT(ctr.id)::int AS contribution_count
       FROM campaigns c
       LEFT JOIN contributions ctr ON ctr.campaign_id = c.id
       WHERE c.creator_id = $1
       GROUP BY c.id
       ORDER BY c.raised_amount DESC
       LIMIT 5`,
      [userId]
    ),
    // Funding velocity: daily cumulative raised per campaign (last 60 days)
    db.query(
      `SELECT c.id AS campaign_id, c.title,
              DATE(ctr.created_at) AS day,
              SUM(ctr.amount)      AS daily_amount
       FROM contributions ctr
       JOIN campaigns c ON c.id = ctr.campaign_id
       WHERE c.creator_id = $1
         AND ctr.created_at >= NOW() - INTERVAL '60 days'
       GROUP BY c.id, c.title, DATE(ctr.created_at)
       ORDER BY c.id, day ASC`,
      [userId]
    ),
    // Contributor retention: returning vs first-time per month (last 6 months)
    db.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', ctr.created_at), 'YYYY-MM') AS month,
         SUM(CASE WHEN prev.sender_public_key IS NOT NULL THEN 1 ELSE 0 END)::int AS returning_count,
         SUM(CASE WHEN prev.sender_public_key IS NULL    THEN 1 ELSE 0 END)::int AS new_count
       FROM contributions ctr
       JOIN campaigns c ON c.id = ctr.campaign_id
       LEFT JOIN (
         SELECT DISTINCT ctr2.sender_public_key
         FROM contributions ctr2
         JOIN campaigns c2 ON c2.id = ctr2.campaign_id
         WHERE c2.creator_id = $1
           AND ctr2.created_at < NOW() - INTERVAL '6 months'
       ) prev ON prev.sender_public_key = ctr.sender_public_key
       WHERE c.creator_id = $1
         AND ctr.created_at >= NOW() - INTERVAL '6 months'
       GROUP BY DATE_TRUNC('month', ctr.created_at)
       ORDER BY month ASC`,
      [userId]
    ),
    // Referral conversion rate: clicks vs contributions per referral code
    db.query(
      `SELECT
         cr.referral_code,
         COUNT(DISTINCT cr.id)::int  AS click_count,
         COUNT(DISTINCT ctr.id)::int AS contribution_count,
         CASE WHEN COUNT(cr.id) = 0 THEN 0
              ELSE ROUND(COUNT(DISTINCT ctr.id)::numeric / COUNT(cr.id) * 100, 2)
         END AS conversion_rate
       FROM campaign_referrals cr
       JOIN campaigns c ON c.id = cr.campaign_id
       LEFT JOIN contributions ctr ON ctr.referral_code = cr.referral_code
       WHERE c.creator_id = $1
       GROUP BY cr.referral_code
       ORDER BY contribution_count DESC
       LIMIT 10`,
      [userId]
    ),
  ]);

  return {
    overview: overviewRows.rows[0],
    recent_trend: trendRows.rows,
    top_campaigns: topCampaignRows.rows,
    funding_velocity: velocityRows.rows,
    contributor_retention: retentionRows.rows,
    referral_conversion: referralRows.rows,
  };
}

module.exports = {
  getCampaignAnalytics,
  getPlatformAnalytics,
  invalidateCampaignAnalytics,
  // Exported for testing
  _analyticsCache: analyticsCache,
  getCampaignContributors,
  getCampaignBackers,
  getUserDashboardAnalytics,
};
