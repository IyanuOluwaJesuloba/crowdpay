const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateIncidentConditions,
  HORIZON_WARN_LATENCY_MS,
  HORIZON_CRIT_LATENCY_MS,
} = require('./incidentDetector');

test('evaluateIncidentConditions returns empty array for healthy snapshot', () => {
  const snapshot = {
    raw_metrics: {
      horizon_testnet_latency: 150,
      horizon_testnet_ok: true,
      sse_dropped_streams_count: 0,
      platform_wallet_balance_xlm: 100.0,
      campaign_wallets_at_risk_count: 0,
      stuck_pending_contributions_count: 0,
      db_longest_query_seconds: 0.2,
    },
  };

  const incidents = evaluateIncidentConditions(snapshot);
  assert.equal(incidents.length, 0);
});

test('evaluateIncidentConditions triggers warning on high Horizon latency (> 2s)', () => {
  const snapshot = {
    raw_metrics: {
      horizon_testnet_latency: 2800,
      horizon_testnet_ok: true,
      sse_dropped_streams_count: 0,
      platform_wallet_balance_xlm: 50.0,
      campaign_wallets_at_risk_count: 0,
      stuck_pending_contributions_count: 0,
      db_longest_query_seconds: 0.1,
    },
  };

  const incidents = evaluateIncidentConditions(snapshot);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].type, 'horizon_latency_high');
  assert.equal(incidents[0].severity, 'warning');
});

test('evaluateIncidentConditions triggers critical on critical Horizon latency or failure', () => {
  const snapshot = {
    raw_metrics: {
      horizon_testnet_latency: 5500,
      horizon_testnet_ok: false,
      sse_dropped_streams_count: 0,
      platform_wallet_balance_xlm: 50.0,
      campaign_wallets_at_risk_count: 0,
      stuck_pending_contributions_count: 0,
      db_longest_query_seconds: 0.1,
    },
  };

  const incidents = evaluateIncidentConditions(snapshot);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].type, 'horizon_latency_critical');
  assert.equal(incidents[0].severity, 'critical');
});

test('evaluateIncidentConditions triggers critical for platform_wallet_low_xlm (< 10 XLM)', () => {
  const snapshot = {
    raw_metrics: {
      horizon_testnet_latency: 100,
      horizon_testnet_ok: true,
      sse_dropped_streams_count: 0,
      platform_wallet_balance_xlm: 4.5,
      campaign_wallets_at_risk_count: 0,
      stuck_pending_contributions_count: 0,
      db_longest_query_seconds: 0.1,
    },
  };

  const incidents = evaluateIncidentConditions(snapshot);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].type, 'platform_wallet_low_xlm');
  assert.equal(incidents[0].severity, 'critical');
});

test('evaluateIncidentConditions triggers warning for underfunded campaign wallets and stuck transactions', () => {
  const snapshot = {
    raw_metrics: {
      horizon_testnet_latency: 100,
      horizon_testnet_ok: true,
      sse_dropped_streams_count: 2,
      platform_wallet_balance_xlm: 20.0,
      campaign_wallets_at_risk_count: 3,
      stuck_pending_contributions_count: 1,
      db_longest_query_seconds: 6.5,
    },
    campaign_wallets: {
      wallets: [{ campaign_id: 'c1', deficit_xlm: 1.5, balance_xlm: 0.5, min_required_xlm: 2.0 }],
    },
  };

  const incidents = evaluateIncidentConditions(snapshot);
  const types = incidents.map((i) => i.type);
  assert.ok(types.includes('sse_stream_dropped'));
  assert.ok(types.includes('campaign_wallet_underfunded'));
  assert.ok(types.includes('stuck_pending_contributions'));
  assert.ok(types.includes('database_slow_query'));
});
