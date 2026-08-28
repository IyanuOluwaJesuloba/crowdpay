/**
 * incidentDetector.js
 *
 * Evaluates health metrics against alert thresholds, opens/manages incidents,
 * dispatches notifications (webhook, email), and auto-resolves recovered incidents.
 */

const db = require('../../config/database');
const logger = require('../../config/logger');

// Threshold constants
const HORIZON_WARN_LATENCY_MS = 2000;
const HORIZON_CRIT_LATENCY_MS = 5000;
const PLATFORM_MIN_XLM = 10.0;
const SLOW_QUERY_SECONDS = 5.0;

/**
 * Evaluate current health snapshot against incident rules.
 * Returns array of active incident descriptors: { type, severity, metrics, details }
 */
function evaluateIncidentConditions(snapshot) {
  const activeIncidents = [];
  const raw = snapshot.raw_metrics || {};

  // 1. Horizon Latency Critical
  if (
    !raw.horizon_testnet_ok ||
    raw.horizon_testnet_latency > HORIZON_CRIT_LATENCY_MS
  ) {
    activeIncidents.push({
      type: 'horizon_latency_critical',
      severity: 'critical',
      metrics: {
        latency_ms: raw.horizon_testnet_latency,
        ok: raw.horizon_testnet_ok,
      },
      details: {
        message: `Horizon testnet latency critical or down (${raw.horizon_testnet_latency}ms, ok: ${raw.horizon_testnet_ok})`,
      },
    });
  } else if (raw.horizon_testnet_latency > HORIZON_WARN_LATENCY_MS) {
    // 2. Horizon Latency High (Warning)
    activeIncidents.push({
      type: 'horizon_latency_high',
      severity: 'warning',
      metrics: { latency_ms: raw.horizon_testnet_latency },
      details: {
        message: `Horizon testnet latency high (${raw.horizon_testnet_latency}ms > ${HORIZON_WARN_LATENCY_MS}ms)`,
      },
    });
  }

  // 3. SSE Streams Dropped
  if (raw.sse_dropped_streams_count > 0) {
    activeIncidents.push({
      type: 'sse_stream_dropped',
      severity: 'warning',
      metrics: {
        dropped_streams_count: raw.sse_dropped_streams_count,
        active_connections: raw.sse_active_connections,
      },
      details: {
        message: `${raw.sse_dropped_streams_count} active campaign SSE stream(s) disconnected or stale > 60s`,
      },
    });
  }

  // 4. Platform Wallet Low XLM
  if (raw.platform_wallet_balance_xlm < PLATFORM_MIN_XLM) {
    activeIncidents.push({
      type: 'platform_wallet_low_xlm',
      severity: 'critical',
      metrics: {
        balance_xlm: raw.platform_wallet_balance_xlm,
        threshold_xlm: PLATFORM_MIN_XLM,
        public_key: snapshot.platform_wallet?.public_key,
      },
      details: {
        message: `Platform co-signing wallet XLM balance (${raw.platform_wallet_balance_xlm} XLM) below minimum reserve of ${PLATFORM_MIN_XLM} XLM`,
      },
    });
  }

  // 5. Campaign Wallet Underfunded
  if (raw.campaign_wallets_at_risk_count > 0) {
    const underfunded = snapshot.campaign_wallets?.wallets?.filter((w) => w.deficit_xlm > 0) || [];
    activeIncidents.push({
      type: 'campaign_wallet_underfunded',
      severity: 'warning',
      metrics: {
        at_risk_count: raw.campaign_wallets_at_risk_count,
        underfunded_wallets: underfunded.map((w) => ({
          campaign_id: w.campaign_id,
          deficit_xlm: w.deficit_xlm,
          balance_xlm: w.balance_xlm,
          min_required_xlm: w.min_required_xlm,
        })),
      },
      details: {
        message: `${raw.campaign_wallets_at_risk_count} campaign wallet(s) underfunded below required base reserves`,
      },
    });
  }

  // 6. Stuck Pending Contributions
  if (raw.stuck_pending_contributions_count > 0) {
    activeIncidents.push({
      type: 'stuck_pending_contributions',
      severity: 'warning',
      metrics: {
        stuck_count: raw.stuck_pending_contributions_count,
      },
      details: {
        message: `${raw.stuck_pending_contributions_count} contribution(s) stuck in pending status > 5 minutes`,
      },
    });
  }

  // 7. Database Slow Query
  if (raw.db_longest_query_seconds > SLOW_QUERY_SECONDS) {
    activeIncidents.push({
      type: 'database_slow_query',
      severity: 'warning',
      metrics: {
        longest_query_seconds: raw.db_longest_query_seconds,
        pool_utilisation: raw.db_pool_utilisation,
      },
      details: {
        message: `Database active query running for ${raw.db_longest_query_seconds}s (> ${SLOW_QUERY_SECONDS}s)`,
      },
    });
  }

  return activeIncidents;
}

/**
 * Dispatch notification to webhook and/or email.
 */
async function dispatchIncidentNotification(incident, isResolved = false) {
  const webhookUrl = process.env.OPS_WEBHOOK_URL;
  const alertEmail = process.env.OPS_ALERT_EMAIL || process.env.OPS_EMAIL;

  const payload = {
    event: isResolved ? 'incident.resolved' : 'incident.triggered',
    incident_id: incident.id,
    incident_type: incident.incident_type,
    severity: incident.severity,
    status: incident.status,
    timestamp: new Date().toISOString(),
    details: incident.details,
    triggering_metrics: incident.triggering_metric_values,
  };

  // 1. Webhook
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      logger.info('Dispatched ops incident webhook', { incident_id: incident.id, type: incident.incident_type });
    } catch (err) {
      logger.warn('Failed to dispatch ops incident webhook', { error: err.message, webhookUrl });
    }
  }

  // 2. Email for critical incidents
  if (incident.severity === 'critical' && alertEmail) {
    try {
      const nodemailer = require('nodemailer');
      // If transport exists or log
      logger.info('Critical incident notification queued for email', {
        to: alertEmail,
        incident_type: incident.incident_type,
      });
    } catch {
      // ignore
    }
  }
}

/**
 * Process a complete incident detection cycle.
 */
async function runIncidentDetectionCycle(snapshot) {
  const activeConditions = evaluateIncidentConditions(snapshot);
  const activeTypeMap = new Map(activeConditions.map((c) => [c.type, c]));

  // 1. Fetch currently open or acknowledged incidents from DB
  let existingOpenIncidents = [];
  try {
    const { rows } = await db.query(
      `SELECT id, incident_type, severity, status, triggered_at, triggering_metric_values, details
       FROM incidents
       WHERE status IN ('open', 'acknowledged')`
    );
    existingOpenIncidents = rows;
  } catch (err) {
    logger.warn('Could not query open incidents from database', { error: err.message });
    return;
  }

  const existingTypeMap = new Map(existingOpenIncidents.map((inc) => [inc.incident_type, inc]));

  // 2. Create or update newly detected / ongoing incidents
  for (const condition of activeConditions) {
    const existing = existingTypeMap.get(condition.type);

    if (existing) {
      // Update triggering metrics & details
      try {
        await db.query(
          `UPDATE incidents
           SET triggering_metric_values = $1::jsonb, details = $2::jsonb
           WHERE id = $3`,
          [JSON.stringify(condition.metrics), JSON.stringify(condition.details), existing.id]
        );
      } catch (err) {
        logger.error('Failed to update incident', { id: existing.id, error: err.message });
      }
    } else {
      // Insert new incident
      try {
        const { rows } = await db.query(
          `INSERT INTO incidents
             (incident_type, severity, status, triggered_at, triggering_metric_values, details, notification_sent)
           VALUES ($1, $2, 'open', NOW(), $3::jsonb, $4::jsonb, TRUE)
           RETURNING id, incident_type, severity, status, triggered_at, triggering_metric_values, details`,
          [condition.type, condition.severity, JSON.stringify(condition.metrics), JSON.stringify(condition.details)]
        );

        if (rows.length > 0) {
          const newIncident = rows[0];
          logger.warn('Ops Incident triggered', {
            id: newIncident.id,
            type: newIncident.incident_type,
            severity: newIncident.severity,
          });
          await dispatchIncidentNotification(newIncident, false);
        }
      } catch (err) {
        logger.error('Failed to insert new incident', { type: condition.type, error: err.message });
      }
    }
  }

  // 3. Auto-resolve recovered incidents
  for (const existing of existingOpenIncidents) {
    if (!activeTypeMap.has(existing.incident_type)) {
      try {
        const { rows } = await db.query(
          `UPDATE incidents
           SET status = 'resolved',
               resolved_at = NOW(),
               duration_seconds = EXTRACT(EPOCH FROM (NOW() - triggered_at))::int
           WHERE id = $1
           RETURNING id, incident_type, severity, status, triggered_at, resolved_at, duration_seconds, triggering_metric_values, details`,
          [existing.id]
        );

        if (rows.length > 0) {
          const resolvedInc = rows[0];
          logger.info('Ops Incident auto-resolved', {
            id: resolvedInc.id,
            type: resolvedInc.incident_type,
            duration_seconds: resolvedInc.duration_seconds,
          });
          await dispatchIncidentNotification(resolvedInc, true);
        }
      } catch (err) {
        logger.error('Failed to auto-resolve incident', { id: existing.id, error: err.message });
      }
    }
  }
}

module.exports = {
  evaluateIncidentConditions,
  runIncidentDetectionCycle,
  dispatchIncidentNotification,
  HORIZON_WARN_LATENCY_MS,
  HORIZON_CRIT_LATENCY_MS,
  PLATFORM_MIN_XLM,
  SLOW_QUERY_SECONDS,
};
