const db = require('../config/database');

async function getCampaignVelocity(campaignId) {
  const { rows: campaignRows } = await db.query(
    `SELECT c.id, c.category, c.target_amount, c.raised_amount, c.deadline,
            COALESCE(c.velocity_alert_threshold, 0) AS velocity_alert_threshold
     FROM campaigns c WHERE c.id = $1`,
    [campaignId]
  );
  if (!campaignRows.length) throw new Error('Campaign not found');
  const campaign = campaignRows[0];

  const targetAmount = Number(campaign.target_amount || 0);
  const raisedAmount = Number(campaign.raised_amount || 0);
  const remainingAmount = Math.max(0, targetAmount - raisedAmount);

  const { rows: txRows } = await db.query(
    `SELECT amount, created_at FROM contributions
     WHERE campaign_id = $1 AND status = 'confirmed'
     ORDER BY created_at ASC`,
    [campaignId]
  );

  const now = Date.now();
  const sumSince = (msAgo) => {
    const cutoff = new Date(now - msAgo);
    return txRows
      .filter(t => new Date(t.created_at) >= cutoff)
      .reduce((acc, t) => acc + Number(t.amount), 0);
  };

  const raised7d = sumSince(7 * 24 * 60 * 60 * 1000);
  const raised30d = sumSince(30 * 24 * 60 * 60 * 1000);

  const hourly = raised7d / (7 * 24);
  const daily = raised7d / 7;
  const weekly = raised7d;

  let projectedCompletionDate = null;
  if (hourly > 0 && remainingAmount > 0) {
    const hoursNeeded = remainingAmount / hourly;
    projectedCompletionDate = new Date(now + hoursNeeded * 3600 * 1000).toISOString();
  } else if (remainingAmount === 0) {
    projectedCompletionDate = new Date().toISOString();
  }

  const { rows: catRows } = await db.query(
    `SELECT AVG(cat_stats.weekly_raised) AS category_avg_weekly
     FROM (
       SELECT c.id, COALESCE(SUM(co.amount), 0) AS weekly_raised
       FROM campaigns c
       LEFT JOIN contributions co ON co.campaign_id = c.id AND co.status = 'confirmed' AND co.created_at >= NOW() - INTERVAL '7 days'
       WHERE c.category = $1 AND c.id != $2
       GROUP BY c.id
     ) cat_stats`,
    [campaign.category || 'other', campaignId]
  );
  const categoryAverageWeekly = Number(catRows[0]?.category_avg_weekly || 0);
  const categoryAverageHourly = categoryAverageWeekly / (7 * 24);

  const threshold = Number(campaign.velocity_alert_threshold || 0);
  const isBelowAlertThreshold = threshold > 0 && hourly < threshold;

  const trend7d = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(now - i * 24 * 3600 * 1000);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const amt = txRows
      .filter(t => {
        const d = new Date(t.created_at);
        return d >= dayStart && d < dayEnd;
      })
      .reduce((sum, t) => sum + Number(t.amount), 0);
    trend7d.push({
      date: dayStart.toISOString().split('T')[0],
      amount: amt,
    });
  }

  const trend30d = [];
  for (let i = 29; i >= 0; i--) {
    const dayStart = new Date(now - i * 24 * 3600 * 1000);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const amt = txRows
      .filter(t => {
        const d = new Date(t.created_at);
        return d >= dayStart && d < dayEnd;
      })
      .reduce((sum, t) => sum + Number(t.amount), 0);
    trend30d.push({
      date: dayStart.toISOString().split('T')[0],
      amount: amt,
    });
  }

  return {
    velocity: {
      amount_per_hour: Math.round(hourly * 100) / 100,
      amount_per_day: Math.round(daily * 100) / 100,
      amount_per_week: Math.round(weekly * 100) / 100,
    },
    projected_completion_date: projectedCompletionDate,
    category_comparison: {
      category: campaign.category || 'other',
      category_avg_weekly: Math.round(categoryAverageWeekly * 100) / 100,
      category_avg_hourly: Math.round(categoryAverageHourly * 100) / 100,
    },
    alerts: {
      threshold,
      is_below_threshold: isBelowAlertThreshold,
    },
    trends: {
      view_7d: trend7d,
      view_30d: trend30d,
    },
  };
}

async function updateCampaignVelocityAlertThreshold(campaignId, threshold) {
  await db.query(
    `UPDATE campaigns SET velocity_alert_threshold = $1 WHERE id = $2`,
    [threshold, campaignId]
  );
  return { success: true, threshold };
}

module.exports = {
  getCampaignVelocity,
  updateCampaignVelocityAlertThreshold,
};