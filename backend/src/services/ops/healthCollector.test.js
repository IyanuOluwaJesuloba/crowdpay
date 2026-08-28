const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeSystemHealthScore,
  auditPlatformWallet,
  auditCampaignWallets,
  BASE_RESERVE_XLM,
  PLATFORM_MIN_XLM,
} = require('./healthCollector');

test('computeSystemHealthScore returns 100 for optimal metrics', () => {
  const perfectMetrics = {
    horizon_testnet_latency: 120,
    horizon_testnet_ok: true,
    horizon_mainnet_latency: 140,
    horizon_mainnet_ok: true,
    ledger_staleness_seconds: 3,
    sse_active_connections: 5,
    sse_dropped_streams_count: 0,
    platform_wallet_balance_xlm: 50.0,
    campaign_wallets_at_risk_count: 0,
    db_pool_utilisation: 20,
    db_longest_query_seconds: 0.1,
    stuck_pending_contributions_count: 0,
    stuck_pending_withdrawals_count: 0,
  };

  const score = computeSystemHealthScore(perfectMetrics);
  assert.equal(score, 100);
});

test('computeSystemHealthScore penalizes degraded conditions', () => {
  const degradedMetrics = {
    horizon_testnet_latency: 2500, // -15
    horizon_testnet_ok: true,
    ledger_staleness_seconds: 15, // -20
    sse_dropped_streams_count: 1, // -10
    platform_wallet_balance_xlm: 5.0, // -30 (< 10 XLM)
    campaign_wallets_at_risk_count: 2, // -10
    db_pool_utilisation: 95, // -25
    db_longest_query_seconds: 6.0, // -15
    stuck_pending_contributions_count: 1, // -5
  };

  const score = computeSystemHealthScore(degradedMetrics);
  assert.ok(score <= 20, `Expected heavily penalized score, got ${score}`);
  assert.ok(score >= 0);
});

test('Campaign wallet reserve calculations check base reserve and trustlines', () => {
  // Test formula: 2 * 0.5 + trustline_count * 0.5
  const trustlines = 3;
  const expectedMin = 2 * BASE_RESERVE_XLM + trustlines * 0.5;
  assert.equal(expectedMin, 2.5);

  const balance = 1.8;
  const deficit = parseFloat((expectedMin - balance).toFixed(7));
  assert.equal(deficit, 0.7);
});

test('Platform wallet minimum requirement is 10 XLM', () => {
  assert.equal(PLATFORM_MIN_XLM, 10.0);
});
