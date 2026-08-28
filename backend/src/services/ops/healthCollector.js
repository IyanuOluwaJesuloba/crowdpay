/**
 * healthCollector.js
 *
 * Background health metric collector for CrowdPay.
 * Collects Horizon connectivity, SSE stream status, platform wallet balance,
 * campaign wallet reserve audits, database pool health, and pending transactions.
 * Stores time-series metrics in `ops_metrics` and computes `system_health_score` (0-100).
 */

const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../../config/database');
const logger = require('../../config/logger');
const { server, isTestnet } = require('../../config/stellar');
const { getLedgerStreamHealth } = require('../ledgerMonitor');

// In-memory cache for fast access
let latestHealthSnapshot = null;
let collectorIntervalId = null;

const BASE_RESERVE_XLM = 0.5;
const PLATFORM_MIN_XLM = 10.0;
const STUCK_CONTRIBUTION_MINUTES = 5;
const STUCK_WITHDRAWAL_HOURS = 24;

/**
 * Get the platform public key from secret or env.
 */
function getPlatformPublicKey() {
  if (process.env.PLATFORM_PUBLIC_KEY) return process.env.PLATFORM_PUBLIC_KEY;
  if (process.env.PLATFORM_SECRET_KEY) {
    try {
      const kp = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
      return kp.publicKey();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Measure round-trip HTTP latency for Horizon fee_stats.
 */
async function checkHorizonFeeStats(horizonUrl) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${horizonUrl.replace(/\/+$/, '')}/fee_stats`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency = Date.now() - start;
    if (!res.ok) {
      return { ok: false, latency_ms: latency, status: res.status, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, latency_ms: latency, status: res.status, fee_stats: data };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: err.name === 'AbortError' ? 'timeout_10s' : err.message,
    };
  }
}

/**
 * Check latest ledger close time staleness.
 */
async function checkLedgerStaleness() {
  try {
    const ledgers = await server.ledgers().order('desc').limit(1).call();
    if (!ledgers || !ledgers.records || ledgers.records.length === 0) {
      return { staleness_seconds: null, closed_at: null, sequence: null, error: 'no_ledgers' };
    }
    const latest = ledgers.records[0];
    const closedAt = new Date(latest.closed_at).getTime();
    const stalenessSeconds = Math.max(0, Math.floor((Date.now() - closedAt) / 1000));
    return {
      staleness_seconds: stalenessSeconds,
      closed_at: latest.closed_at,
      sequence: latest.sequence,
      stale: stalenessSeconds > 10,
    };
  } catch (err) {
    return { staleness_seconds: null, closed_at: null, sequence: null, error: err.message };
  }
}

/**
 * Audit platform co-signing wallet balance & pending transactions.
 */
async function auditPlatformWallet() {
  const pubKey = getPlatformPublicKey();
  if (!pubKey) {
    return {
      public_key: null,
      balance_xlm: 0,
      is_low: true,
      pending_transactions_count: 0,
      estimated_xlm_needed: 0,
      stale_pending_count: 0,
    };
  }

  let balanceXlm = 0;
  try {
    const acc = await server.loadAccount(pubKey);
    const nativeBal = acc.balances.find((b) => b.asset_type === 'native');
    balanceXlm = nativeBal ? parseFloat(nativeBal.balance) : 0;
  } catch (err) {
    logger.warn('Failed to load platform account from Horizon', { error: err.message, pubKey });
  }

  // Check pending transactions & estimate fee needs
  let pendingCount = 0;
  let stalePendingCount = 0;
  try {
    const { rows } = await db.query(
      `SELECT id, created_at, (NOW() - created_at) > INTERVAL '5 minutes' AS is_stale
       FROM stellar_transactions
       WHERE status IN ('submitted', 'pending_signatures')`
    );
    pendingCount = rows.length;
    stalePendingCount = rows.filter((r) => r.is_stale).length;
  } catch {
    // If table doesn't exist yet or query fails
  }

  // Estimated XLM needed = base operations fee * pending operations
  const estimatedXlmNeeded = parseFloat((pendingCount * 0.0001 + 5.0).toFixed(7));

  return {
    public_key: pubKey,
    balance_xlm: balanceXlm,
    is_low: balanceXlm < PLATFORM_MIN_XLM,
    pending_transactions_count: pendingCount,
    stale_pending_count: stalePendingCount,
    estimated_xlm_needed: estimatedXlmNeeded,
  };
}

/**
 * Audit campaign wallet reserves.
 * Minimum reserve formula: (2 * base_reserve + trustline_count * 0.5 XLM)
 */
async function auditCampaignWallets() {
  let campaigns = [];
  try {
    const { rows } = await db.query(
      `SELECT id, title, wallet_public_key, status
       FROM campaigns
       WHERE status IN ('active', 'funded') AND wallet_public_key IS NOT NULL`
    );
    campaigns = rows;
  } catch (err) {
    logger.error('Failed to query campaigns for wallet audit', { error: err.message });
    return { wallets: [], total_audited: 0, at_risk_count: 0 };
  }

  const auditedWallets = [];
  let atRiskCount = 0;

  for (const c of campaigns) {
    let balanceXlm = 0;
    let trustlineCount = 0;
    let loadError = null;

    try {
      const acc = await server.loadAccount(c.wallet_public_key);
      const native = acc.balances.find((b) => b.asset_type === 'native');
      balanceXlm = native ? parseFloat(native.balance) : 0;
      trustlineCount = acc.balances.filter((b) => b.asset_type !== 'native').length;
    } catch (err) {
      loadError = err.message;
    }

    const minRequired = parseFloat(
      (2 * BASE_RESERVE_XLM + trustlineCount * 0.5).toFixed(7)
    );
    const rawDeficit = minRequired - balanceXlm;
    const deficit = rawDeficit > 0 ? parseFloat(rawDeficit.toFixed(7)) : 0;

    let health = 'ok';
    if (deficit > 0 || loadError) {
      health = deficit >= 1.0 ? 'critical' : 'warning';
      atRiskCount++;
    }

    auditedWallets.push({
      campaign_id: c.id,
      campaign_title: c.title,
      wallet_public_key: c.wallet_public_key,
      campaign_status: c.status,
      balance_xlm: balanceXlm,
      min_required_xlm: minRequired,
      deficit_xlm: deficit,
      trustline_count: trustlineCount,
      health,
      load_error: loadError,
    });
  }

  return {
    wallets: auditedWallets,
    total_audited: auditedWallets.length,
    at_risk_count: atRiskCount,
  };
}

/**
 * Check database connection pool & slow queries.
 */
async function auditDatabase() {
  const poolMetrics = typeof db.getPoolMetrics === 'function'
    ? db.getPoolMetrics()
    : { total: 0, idle: 0, waiting: 0, max: 10, utilisation: 0 };

  let longestQuerySeconds = 0;
  let slowQueryDetected = false;

  try {
    const { rows } = await db.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - query_start)) AS duration_sec
       FROM pg_stat_activity
       WHERE state = 'active' AND pid <> pg_backend_pid()
       ORDER BY duration_sec DESC
       LIMIT 1`
    );
    if (rows.length > 0 && rows[0].duration_sec != null) {
      longestQuerySeconds = Math.max(0, parseFloat(rows[0].duration_sec));
      if (longestQuerySeconds > 5) {
        slowQueryDetected = true;
      }
    }
  } catch {
    // If pg_stat_activity permissions are restricted
  }

  return {
    pool: poolMetrics,
    longest_query_seconds: parseFloat(longestQuerySeconds.toFixed(3)),
    slow_query_detected: slowQueryDetected,
    replication_lag_seconds: 0,
  };
}

/**
 * Audit stuck pending contributions and withdrawals.
 */
async function auditPendingTransactions() {
  let stuckContributionsCount = 0;
  let stuckWithdrawalsCount = 0;
  let stuckContributions = [];
  let stuckWithdrawals = [];

  try {
    const { rows: contributions } = await db.query(
      `SELECT id, campaign_id, amount, asset, tx_hash, created_at,
              EXTRACT(EPOCH FROM (NOW() - created_at)) / 60 AS age_minutes
       FROM contributions
       WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'
       ORDER BY created_at ASC
       LIMIT 50`
    );
    stuckContributions = contributions;
    stuckContributionsCount = contributions.length;
  } catch {
    // ignore if table/columns differ
  }

  try {
    const { rows: withdrawals } = await db.query(
      `SELECT id, campaign_id, amount, status, created_at,
              EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 AS age_hours
       FROM withdrawal_requests
       WHERE status = 'pending_creator' AND created_at < NOW() - INTERVAL '24 hours'
       ORDER BY created_at ASC
       LIMIT 50`
    );
    stuckWithdrawals = withdrawals;
    stuckWithdrawalsCount = withdrawals.length;
  } catch {
    // ignore
  }

  return {
    stuck_contributions_count: stuckContributionsCount,
    stuck_withdrawals_count: stuckWithdrawalsCount,
    stuck_contributions: stuckContributions,
    stuck_withdrawals: stuckWithdrawals,
  };
}

/**
 * Calculate rolling system health score (0-100).
 */
function computeSystemHealthScore(metrics) {
  let score = 100;

  // Horizon latency penalties
  if (metrics.horizon_testnet_latency > 5000 || !metrics.horizon_testnet_ok) {
    score -= 30;
  } else if (metrics.horizon_testnet_latency > 2000) {
    score -= 15;
  }

  // Ledger staleness
  if (metrics.ledger_staleness_seconds > 10) {
    score -= 20;
  }

  // SSE dropped streams
  if (metrics.sse_dropped_streams_count > 0) {
    score -= Math.min(30, metrics.sse_dropped_streams_count * 10);
  }

  // Platform wallet low XLM
  if (metrics.platform_wallet_balance_xlm < PLATFORM_MIN_XLM) {
    score -= 30;
  }

  // Campaign wallets at risk
  if (metrics.campaign_wallets_at_risk_count > 0) {
    score -= Math.min(25, metrics.campaign_wallets_at_risk_count * 5);
  }

  // Database pool saturation / slow queries
  if (metrics.db_pool_utilisation > 90) {
    score -= 25;
  } else if (metrics.db_pool_utilisation > 75) {
    score -= 10;
  }
  if (metrics.db_longest_query_seconds > 5) {
    score -= 15;
  }

  // Stuck transactions
  if (metrics.stuck_pending_contributions_count > 0) {
    score -= Math.min(20, metrics.stuck_pending_contributions_count * 5);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Collect all health metrics, persist to DB, and return snapshot.
 */
async function collectHealthMetrics() {
  const collectedAt = new Date();

  // 1. Horizon & Ledger
  const testnetUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const mainnetUrl = 'https://horizon.stellar.org';

  const [testnetHorizon, mainnetHorizon, ledgerStatus] = await Promise.all([
    checkHorizonFeeStats(testnetUrl),
    checkHorizonFeeStats(mainnetUrl),
    checkLedgerStaleness(),
  ]);

  // 2. SSE stream health
  let sseHealth = { active_campaigns: 0, streams: [] };
  try {
    if (typeof getLedgerStreamHealth === 'function') {
      sseHealth = await getLedgerStreamHealth();
    }
  } catch (err) {
    logger.warn('Failed to retrieve ledger stream health', { error: err.message });
  }

  const activeSseConnections = sseHealth.streams.filter((s) => s.stream_state === 'connected').length;
  const droppedSseStreams = sseHealth.streams.filter(
    (s) => s.stream_state === 'not_connected' || s.stale_stream_no_messages_15m
  ).length;

  // 3. Platform wallet & campaigns
  const [platformWallet, campaignAudits, dbHealth, pendingTxs] = await Promise.all([
    auditPlatformWallet(),
    auditCampaignWallets(),
    auditDatabase(),
    auditPendingTransactions(),
  ]);

  // Metric breakdown dictionary
  const rawMetrics = {
    horizon_testnet_latency: testnetHorizon.latency_ms || 0,
    horizon_testnet_ok: testnetHorizon.ok,
    horizon_mainnet_latency: mainnetHorizon.latency_ms || 0,
    horizon_mainnet_ok: mainnetHorizon.ok,
    ledger_staleness_seconds: ledgerStatus.staleness_seconds || 0,
    sse_active_connections: activeSseConnections,
    sse_dropped_streams_count: droppedSseStreams,
    platform_wallet_balance_xlm: platformWallet.balance_xlm,
    platform_wallet_is_low: platformWallet.is_low,
    campaign_wallets_at_risk_count: campaignAudits.at_risk_count,
    db_pool_utilisation: dbHealth.pool.utilisation || 0,
    db_longest_query_seconds: dbHealth.longest_query_seconds || 0,
    stuck_pending_contributions_count: pendingTxs.stuck_contributions_count,
    stuck_pending_withdrawals_count: pendingTxs.stuck_withdrawals_count,
  };

  const healthScore = computeSystemHealthScore(rawMetrics);

  const snapshot = {
    collected_at: collectedAt.toISOString(),
    system_health_score: healthScore,
    horizon: {
      testnet: testnetHorizon,
      mainnet: mainnetHorizon,
      ledger: ledgerStatus,
    },
    sse_streams: {
      active_connections: activeSseConnections,
      dropped_count: droppedSseStreams,
      total_monitored: sseHealth.active_campaigns,
      streams: sseHealth.streams,
    },
    platform_wallet: platformWallet,
    campaign_wallets: campaignAudits,
    database: dbHealth,
    pending_transactions: pendingTxs,
    raw_metrics: rawMetrics,
  };

  latestHealthSnapshot = snapshot;

  // Persist metrics to `ops_metrics`
  await persistMetrics(collectedAt, rawMetrics);

  return snapshot;
}

/**
 * Batch insert metrics to `ops_metrics` table.
 */
async function persistMetrics(collectedAt, metrics) {
  const entries = [
    { name: 'horizon_testnet_latency_ms', value: metrics.horizon_testnet_latency, breached: metrics.horizon_testnet_latency > 2000 },
    { name: 'horizon_mainnet_latency_ms', value: metrics.horizon_mainnet_latency, breached: metrics.horizon_mainnet_latency > 2000 },
    { name: 'ledger_staleness_seconds', value: metrics.ledger_staleness_seconds, breached: metrics.ledger_staleness_seconds > 10 },
    { name: 'sse_active_connections', value: metrics.sse_active_connections, breached: false },
    { name: 'sse_dropped_streams_count', value: metrics.sse_dropped_streams_count, breached: metrics.sse_dropped_streams_count > 0 },
    { name: 'platform_wallet_balance_xlm', value: metrics.platform_wallet_balance_xlm, breached: metrics.platform_wallet_balance_xlm < PLATFORM_MIN_XLM },
    { name: 'campaign_wallets_at_risk_count', value: metrics.campaign_wallets_at_risk_count, breached: metrics.campaign_wallets_at_risk_count > 0 },
    { name: 'db_pool_utilisation', value: metrics.db_pool_utilisation, breached: metrics.db_pool_utilisation > 80 },
    { name: 'db_longest_query_seconds', value: metrics.db_longest_query_seconds, breached: metrics.db_longest_query_seconds > 5 },
    { name: 'stuck_pending_contributions_count', value: metrics.stuck_pending_contributions_count, breached: metrics.stuck_pending_contributions_count > 0 },
    { name: 'stuck_pending_withdrawals_count', value: metrics.stuck_pending_withdrawals_count, breached: metrics.stuck_pending_withdrawals_count > 0 },
  ];

  for (const m of entries) {
    try {
      await db.query(
        `INSERT INTO ops_metrics (collected_at, metric_name, metric_value, metric_labels, threshold_breached)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [collectedAt, m.name, m.value, JSON.stringify({}), m.breached]
      );
    } catch (err) {
      // Don't crash collection if table not ready
    }
  }
}

/**
 * Start health collector background timer (every 30 seconds).
 */
function startHealthCollector(intervalMs = 30000) {
  if (collectorIntervalId) return;

  const { runIncidentDetectionCycle } = require('./incidentDetector');

  const execute = async () => {
    try {
      const snapshot = await collectHealthMetrics();
      await runIncidentDetectionCycle(snapshot);
    } catch (err) {
      logger.error('Ops Health Collector cycle failed', { error: err.message });
    }
  };

  // Run initial cycle
  execute().catch(() => {});

  collectorIntervalId = setInterval(execute, intervalMs);
  logger.info('Ops Health Collector started', { intervalMs });
}

function stopHealthCollector() {
  if (collectorIntervalId) {
    clearInterval(collectorIntervalId);
    collectorIntervalId = null;
    logger.info('Ops Health Collector stopped');
  }
}

function getLatestHealthSnapshot() {
  return latestHealthSnapshot;
}

module.exports = {
  collectHealthMetrics,
  startHealthCollector,
  stopHealthCollector,
  getLatestHealthSnapshot,
  computeSystemHealthScore,
  auditPlatformWallet,
  auditCampaignWallets,
  auditDatabase,
  auditPendingTransactions,
  getPlatformPublicKey,
  BASE_RESERVE_XLM,
  PLATFORM_MIN_XLM,
};
