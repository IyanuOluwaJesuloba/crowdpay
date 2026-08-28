/**
 * ops.js
 *
 * Operations Centre REST API.
 * Requires `OPS_API_KEY` header for all routes to isolate ops access from user JWTs.
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const logger = require('../config/logger');
const {
  collectHealthMetrics,
  getLatestHealthSnapshot,
  auditCampaignWallets,
} = require('../services/ops/healthCollector');
const { executeRunbook } = require('../services/ops/runbooks');

/**
 * Middleware to require and validate OPS_API_KEY.
 */
function requireOpsApiKey(req, res, next) {
  const configuredKey = process.env.OPS_API_KEY || 'ops_secret_dev_key';
  const providedKey =
    req.headers['ops_api_key'] ||
    req.headers['ops-api-key'] ||
    req.headers['x-ops-api-key'] ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!providedKey || providedKey !== configuredKey) {
    logger.warn('Unauthorized access attempt to /api/ops', {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED_OPS',
        message: 'Invalid or missing OPS_API_KEY header.',
      },
    });
  }

  next();
}

router.use(requireOpsApiKey);

/**
 * GET /api/ops/health
 * Returns the current health score, latest metric breakdown, and subsystem status.
 */
router.get('/health', async (req, res, next) => {
  try {
    const forceFresh = req.query.fresh === 'true';
    let snapshot = getLatestHealthSnapshot();

    if (!snapshot || forceFresh) {
      snapshot = await collectHealthMetrics();
    }

    res.json({
      status: 'ok',
      health_score: snapshot.system_health_score,
      collected_at: snapshot.collected_at,
      data: snapshot,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ops/metrics/history
 * Returns historical time-series data for a specific metric.
 */
router.get('/metrics/history', async (req, res, next) => {
  try {
    const { metric = 'horizon_testnet_latency_ms', from, to, limit = 100 } = req.query;

    const fromDate = from ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    const { rows } = await db.query(
      `SELECT id, collected_at, metric_name, metric_value, metric_labels, threshold_breached
       FROM ops_metrics
       WHERE metric_name = $1 AND collected_at >= $2 AND collected_at <= $3
       ORDER BY collected_at ASC
       LIMIT $4`,
      [metric, fromDate, toDate, parseInt(limit, 10)]
    );

    res.json({
      metric_name: metric,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      count: rows.length,
      history: rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ops/incidents
 * List open, acknowledged, and resolved incidents with pagination and filtering.
 */
router.get('/incidents', async (req, res, next) => {
  try {
    const { status = 'all', severity = 'all', page = 1, limit = 20 } = req.query;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);

    const conditions = [];
    const params = [];

    if (status !== 'all') {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    if (severity !== 'all') {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await db.query(`SELECT COUNT(*) AS total FROM incidents ${whereClause}`, params);
    const total = parseInt(countRes.rows[0].total, 10);

    params.push(parseInt(limit, 10));
    params.push(offset);

    const { rows } = await db.query(
      `SELECT id, incident_type, severity, status, triggered_at, acknowledged_at,
              resolved_at, duration_seconds, triggering_metric_values, details, notification_sent
       FROM incidents
       ${whereClause}
       ORDER BY CASE WHEN status = 'open' THEN 1 WHEN status = 'acknowledged' THEN 2 ELSE 3 END,
                triggered_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      total,
      incidents: rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ops/incidents/:id
 * Retrieve single incident details and associated runbook executions.
 */
router.get('/incidents/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query('SELECT * FROM incidents WHERE id = $1', [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Incident not found' } });
    }

    const incident = rows[0];

    const { rows: executions } = await db.query(
      `SELECT id, runbook_type, status, steps, started_at, completed_at
       FROM runbook_executions
       WHERE incident_id = $1
       ORDER BY started_at DESC`,
      [id]
    );

    res.json({
      incident,
      runbook_executions: executions,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/ops/incidents/:id/acknowledge
 * Mark incident as acknowledged.
 */
router.post('/incidents/:id/acknowledge', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `UPDATE incidents
       SET status = 'acknowledged', acknowledged_at = NOW()
       WHERE id = $1 AND status = 'open'
       RETURNING *`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Open incident not found or already acknowledged' },
      });
    }

    logger.info('Incident acknowledged by operator', { incident_id: id });
    res.json({ status: 'ok', incident: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ops/campaigns/wallet-audit
 * Detailed campaign wallet reserve audit.
 */
router.get('/campaigns/wallet-audit', async (req, res, next) => {
  try {
    const audit = await auditCampaignWallets();
    res.json(audit);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/ops/campaigns/wallet-audit/:campaignId/approve-funding
 * Approve top-up transfer for underfunded campaign wallet.
 */
router.post('/campaigns/wallet-audit/:campaignId/approve-funding', async (req, res, next) => {
  try {
    const { campaignId } = req.params;
    const audit = await auditCampaignWallets();
    const target = audit.wallets.find((w) => w.campaign_id === campaignId);

    if (!target) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Campaign wallet not found in audit' },
      });
    }

    logger.info('Operator approved funding for campaign wallet', {
      campaign_id: campaignId,
      deficit_xlm: target.deficit_xlm,
    });

    res.json({
      status: 'approved',
      campaign_id: campaignId,
      deficit_xlm: target.deficit_xlm,
      message: `Funding approval recorded for ${target.campaign_title}. Deficit: ${target.deficit_xlm} XLM.`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/ops/runbooks/:incidentId/execute
 * Execute automated runbook for an incident.
 */
router.post('/runbooks/:incidentId/execute', async (req, res, next) => {
  try {
    const { incidentId } = req.params;
    const { runbook_type } = req.body || {};

    const execution = await executeRunbook(incidentId, runbook_type);
    res.json({
      status: 'ok',
      execution,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ops/runbooks/:incidentId/status
 * Get status and step logs for the latest runbook execution of an incident.
 */
router.get('/runbooks/:incidentId/status', async (req, res, next) => {
  try {
    const { incidentId } = req.params;
    const { rows } = await db.query(
      `SELECT id, incident_id, runbook_type, status, steps, started_at, completed_at
       FROM runbook_executions
       WHERE incident_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [incidentId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'No runbook executions found for this incident' },
      });
    }

    res.json({ execution: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.requireOpsApiKey = requireOpsApiKey;
