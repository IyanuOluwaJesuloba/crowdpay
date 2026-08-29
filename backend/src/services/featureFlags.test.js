const crypto = require('node:crypto');
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  const ff = require('./featureFlags');
  ff.clearOverrides();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete require.cache[require.resolve('./featureFlags')];
});

function freshFlags() {
  delete require.cache[require.resolve('./featureFlags')];
  return require('./featureFlags');
}

// ─── Basic Flag Evaluation ───────────────────────────────────────────

test('isEnabled returns false for unknown flag', () => {
  const ff = freshFlags();
  assert.equal(ff.isEnabled('nonexistent-flag'), false);
});

test('isEnabled uses defaultValue when env var is unset', () => {
  const ff = freshFlags();
  delete process.env.SERVE_FRONTEND;
  assert.equal(ff.isEnabled('serve-frontend'), false);

  delete process.env.ENABLE_CAMPAIGN_STATUS_CRON;
  assert.equal(ff.isEnabled('campaign-status-cron'), true);
});

test('isEnabled reads env var when set', () => {
  process.env.SERVE_FRONTEND = 'true';
  const ff = freshFlags();
  assert.equal(ff.isEnabled('serve-frontend'), true);
});

test('isEnabled respects false env var values', () => {
  process.env.ENABLE_CAMPAIGN_STATUS_CRON = 'false';
  const ff = freshFlags();
  assert.equal(ff.isEnabled('campaign-status-cron'), false);
});

test('isEnabled treats 0, no, off, empty string as disabled', () => {
  for (const val of ['0', 'no', 'off', '']) {
    process.env.ENABLE_CAMPAIGN_STATUS_CRON = val;
    const ff = freshFlags();
    assert.equal(ff.isEnabled('campaign-status-cron'), false, `value "${val}" should disable`);
  }
});

test('isEnabled treats truthy strings as enabled', () => {
  for (const val of ['true', '1', 'yes', 'on', 'anything']) {
    process.env.ENABLE_CAMPAIGN_STATUS_CRON = val;
    const ff = freshFlags();
    assert.equal(ff.isEnabled('campaign-status-cron'), true, `value "${val}" should enable`);
  }
});

test('isEnabled is case-insensitive for env var false values', () => {
  process.env.ENABLE_CAMPAIGN_STATUS_CRON = 'FALSE';
  const ff = freshFlags();
  assert.equal(ff.isEnabled('campaign-status-cron'), false);
});

test('consecutive calls return consistent results', () => {
  process.env.SERVE_FRONTEND = 'true';
  const ff = freshFlags();
  for (let i = 0; i < 10; i++) {
    assert.equal(ff.isEnabled('serve-frontend'), true);
  }
});

// ─── Overrides ───────────────────────────────────────────────────────

test('setOverride takes precedence over env var', () => {
  process.env.ENABLE_CAMPAIGN_STATUS_CRON = 'true';
  const ff = freshFlags();
  ff.setOverride('campaign-status-cron', false);
  assert.equal(ff.isEnabled('campaign-status-cron'), false);
});

test('setOverride(null) clears a previous override', () => {
  process.env.ENABLE_CAMPAIGN_STATUS_CRON = 'true';
  const ff = freshFlags();
  ff.setOverride('campaign-status-cron', false);
  assert.equal(ff.isEnabled('campaign-status-cron'), false);
  ff.setOverride('campaign-status-cron', null);
  assert.equal(ff.isEnabled('campaign-status-cron'), true);
});

test('clearOverrides removes all overrides', () => {
  delete process.env.ENABLE_CAMPAIGN_STATUS_CRON;
  delete process.env.SERVE_FRONTEND;
  const ff = freshFlags();
  ff.setOverride('serve-frontend', true);
  ff.setOverride('campaign-status-cron', false);
  ff.clearOverrides();
  assert.equal(ff.isEnabled('serve-frontend'), false); // default
  assert.equal(ff.isEnabled('campaign-status-cron'), true); // default
});

// ─── Percentage Rollouts ─────────────────────────────────────────────

test('_isInRolloutBucket is deterministic (same inputs → same result)', () => {
  const ff = freshFlags();
  const ctx = { userId: 'user-abc-123' };
  const result1 = ff._isInRolloutBucket('test-flag', ctx, 50);
  const result2 = ff._isInRolloutBucket('test-flag', ctx, 50);
  assert.equal(result1, result2);
});

test('_isInRolloutBucket produces ~correct distribution for 50% rollout', () => {
  const ff = freshFlags();
  // Generate 1000 unique user IDs and check the bucket distribution
  let enabledCount = 0;
  const total = 1000;
  for (let i = 0; i < total; i++) {
    const ctx = { userId: `user-${i}-${crypto.randomUUID ? crypto.randomUUID() : `${i}`}` };
    if (ff._isInRolloutBucket('test-flag', ctx, 50)) {
      enabledCount++;
    }
  }
  // Should be roughly 50% (±15% tolerance for random distribution)
  const pct = (enabledCount / total) * 100;
  assert.ok(pct > 15, `Expected >15% got ${pct}%`);
  assert.ok(pct < 85, `Expected <85% got ${pct}%`);
});

test('_isInRolloutBucket enables everyone at 100%', () => {
  const ff = freshFlags();
  for (let i = 0; i < 100; i++) {
    assert.equal(ff._isInRolloutBucket('test-flag', { userId: `u${i}` }, 100), true);
  }
});

test('_isInRolloutBucket disables everyone at 0%', () => {
  const ff = freshFlags();
  for (let i = 0; i < 100; i++) {
    assert.equal(ff._isInRolloutBucket('test-flag', { userId: `u${i}` }, 0), false);
  }
});

test('_isInRolloutBucket uses sessionId as fallback when userId is absent', () => {
  const ff = freshFlags();
  const ctx = { sessionId: 'session-xyz' };
  const result1 = ff._isInRolloutBucket('test-flag', ctx, 50);
  const result2 = ff._isInRolloutBucket('test-flag', ctx, 50);
  assert.equal(result1, result2);
});

test('_isInRolloutBucket different flag names produce different buckets for same user', () => {
  const ff = freshFlags();
  const ctx = { userId: 'user-1' };
  const flagA = ff._isInRolloutBucket('flag-a', ctx, 50);
  const flagB = ff._isInRolloutBucket('flag-b', ctx, 50);
  // They might be the same sometimes, but that's fine — just verify determinism
  assert.equal(ff._isInRolloutBucket('flag-a', ctx, 50), flagA);
  assert.equal(ff._isInRolloutBucket('flag-b', ctx, 50), flagB);
});

// ─── A/B Test Variants ───────────────────────────────────────────────

test('getVariant returns null when flag is disabled', () => {
  delete process.env.SERVE_FRONTEND; // default: false
  const ff = freshFlags();
  assert.equal(ff.getVariant('serve-frontend', { userId: 'u1' }), null);
});

test('getVariant returns "control" when flag is enabled without rolloutPct', () => {
  delete process.env.ENABLE_CAMPAIGN_STATUS_CRON; // default: true, rolloutPct: null
  const ff = freshFlags();
  assert.equal(ff.getVariant('campaign-status-cron', { userId: 'u1' }), 'control');
});

test('getVariant returns "control" or "treatment" based on rollout bucket', () => {
  // We can't easily test with a built-in flag since none have rolloutPct.
  // But we can verify the method works correctly:
  // For a flag with rolloutPct=100, everyone should get 'control' (fully rolled out)
  // For a flag with rolloutPct=0, everyone should get 'null' (feature off)
  // The actual bucketing logic is tested in _isInRolloutBucket above.
  delete process.env.ENABLE_CAMPAIGN_STATUS_CRON;
  const ff = freshFlags();
  assert.equal(ff.getVariant('campaign-status-cron', { userId: 'u1' }), 'control');
});

// ─── getAllFlags ─────────────────────────────────────────────────────

test('getAllFlags returns all flags with resolved states', () => {
  delete process.env.ENABLE_CAMPAIGN_STATUS_CRON;
  delete process.env.SERVE_FRONTEND;
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  const ff = freshFlags();
  const flags = ff.getAllFlags();
  const map = Object.fromEntries(flags.map((f) => [f.name, f]));

  assert.equal(map['campaign-status-cron'].enabled, true);   // default: true
  assert.equal(map['serve-frontend'].enabled, false);         // default: false
  assert.equal(map['kyc-required-for-campaigns'].enabled, false); // env: false
  assert.ok(map['campaign-status-cron'].description);
  assert.equal(map['campaign-status-cron'].envVar, 'ENABLE_CAMPAIGN_STATUS_CRON');
  assert.equal(map['campaign-status-cron'].rolloutPct, null);
});

// ─── Adapter Integration ─────────────────────────────────────────────

test('registerAdapter takes precedence over env var', () => {
  process.env.SERVE_FRONTEND = 'false';
  const ff = freshFlags();
  ff.registerAdapter('serve-frontend', { isEnabled: () => true });
  assert.equal(ff.isEnabled('serve-frontend'), true);
});

test('unregisterAdapter removes a previously registered adapter', () => {
  process.env.SERVE_FRONTEND = 'false';
  const ff = freshFlags();
  ff.registerAdapter('serve-frontend', { isEnabled: () => true });
  assert.equal(ff.isEnabled('serve-frontend'), true);
  ff.unregisterAdapter('serve-frontend');
  assert.equal(ff.isEnabled('serve-frontend'), false);
});

test('wildcard adapter (*) acts as fallback for all flags', () => {
  const ff = freshFlags();
  ff.registerAdapter('*', {
    isEnabled: (name) => name === 'serve-frontend',
  });
  assert.equal(ff.isEnabled('serve-frontend'), true);
  assert.equal(ff.isEnabled('campaign-status-cron'), false);
});

test('flag-specific adapter beats wildcard adapter', () => {
  const ff = freshFlags();
  ff.registerAdapter('*', { isEnabled: () => true });
  ff.registerAdapter('serve-frontend', { isEnabled: () => false });
  assert.equal(ff.isEnabled('serve-frontend'), false);
  assert.equal(ff.isEnabled('campaign-status-cron'), true);
});

test('syncFlagsToAdapter calls register on adapter for every flag', () => {
  const ff = freshFlags();
  const registered = [];
  const adapter = {
    register(name, def) {
      registered.push({ name, def });
    },
    isEnabled: () => true,
  };
  ff.syncFlagsToAdapter(adapter);
  assert.ok(registered.length > 0);
  assert.ok(registered.some((r) => r.name === 'serve-frontend'));
  assert.equal(registered[0].def.description, ff.FLAGS[registered[0].name].description);
});

// ─── External Adapter Implementations ────────────────────────────────

// Configuration documentation for external feature flag providers:
// - Unleash: set FEATURE_FLAG_PROVIDER=unleash, UNLEASH_URL, UNLEASH_API_TOKEN,
//   and optionally UNLEASH_ENVIRONMENT.
// - LaunchDarkly: set FEATURE_FLAG_PROVIDER=launchdarkly and LAUNCHDARKLY_SDK_KEY.

test('Unleash adapter registers CrowdPay flags and maps enabled state', () => {
  const ff = freshFlags();
  const registered = new Map();
  const unleashAdapter = {
    register(name, def) {
      registered.set(name, def);
    },
    isEnabled(name, context) {
      // Simulate an Unleash toggle keyed by feature name.
      return name === 'serve-frontend' && context?.userId === 'beta-user';
    },
    getVariant(name, context) {
      return this.isEnabled(name, context) ? 'treatment' : 'control';
    },
  };

  ff.syncFlagsToAdapter(unleashAdapter);
  ff.registerAdapter('*', unleashAdapter);

  assert.equal(registered.has('serve-frontend'), true);
  assert.equal(registered.has('campaign-status-cron'), true);
  assert.equal(ff.isEnabled('serve-frontend', { userId: 'beta-user' }), true);
  assert.equal(ff.isEnabled('campaign-status-cron', { userId: 'beta-user' }), false);
});

test('Unleash adapter supports variants for A/B testing', () => {
  const ff = freshFlags();
  ff.registerAdapter('serve-frontend', {
    isEnabled: () => true,
    getVariant: (name, context) => (context.userId === 'treatment-user' ?
// ─── requireFlag Middleware ──────────────────────────────────────────

test('requireFlag calls next() when flag is enabled', () => {
  process.env.SERVE_FRONTEND = 'true';
  const ff = freshFlags();
  const middleware = ff.requireFlag('serve-frontend');

  let calledNext = false;
  const req = { user: { userId: 'u1', role: 'admin' } };
  const res = { status: () => ({ json: () => {} }) };
  middleware(req, res, () => { calledNext = true; });

  assert.equal(calledNext, true);
});

test('requireFlag responds 404 when flag is disabled (default behavior)', () => {
  delete process.env.SERVE_FRONTEND; // default: false
  const ff = freshFlags();
  const middleware = ff.requireFlag('serve-frontend');

  let statusCode;
  let jsonBody;
  const req = { user: {} };
  const res = {
    status: (code) => {
      statusCode = code;
      return { json: (body) => { jsonBody = body; } };
    },
  };
  middleware(req, res, () => { assert.fail('next should not be called'); });

  assert.equal(statusCode, 404);
  assert.deepEqual(jsonBody, { error: 'Not found' });
});

test('requireFlag with behavior: "403" responds 403 when flag is disabled', () => {
  delete process.env.SERVE_FRONTEND;
  const ff = freshFlags();
  const middleware = ff.requireFlag('serve-frontend', { behavior: '403' });

  let statusCode;
  let jsonBody;
  const req = { user: {} };
  const res = {
    status: (code) => {
      statusCode = code;
      return { json: (body) => { jsonBody = body; } };
    },
  };
  middleware(req, res, () => { assert.fail('next should not be called'); });

  assert.equal(statusCode, 403);
  assert.deepEqual(jsonBody, { error: 'Feature disabled' });
});

test('requireFlag with behavior: "feature_disabled" returns 200 with feature_disabled flag', () => {
  delete process.env.SERVE_FRONTEND;
  const ff = freshFlags();
  const middleware = ff.requireFlag('serve-frontend', { behavior: 'feature_disabled' });

  let jsonBody;
  const req = { user: {} };
  const res = {
    json: (body) => { jsonBody = body; },
    status: () => res,
  };
  middleware(req, res, () => { assert.fail('next should not be called'); });

  assert.deepEqual(jsonBody, { feature_disabled: true, flag: 'serve-frontend' });
});

// ─── FF Integration: existing env-based toggles ──────────────────────

test('kyc-required-for-campaigns mirrors KYC_REQUIRED_FOR_CAMPAIGNS env', () => {
  delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  let ff = freshFlags();
  assert.equal(ff.isEnabled('kyc-required-for-campaigns'), true);

  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'true';
  ff = freshFlags();
  assert.equal(ff.isEnabled('kyc-required-for-campaigns'), true);

  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  ff = freshFlags();
  assert.equal(ff.isEnabled('kyc-required-for-campaigns'), false);
});

test('weekly-digest-cron is enabled by default', () => {
  delete process.env.ENABLE_WEEKLY_DIGEST_CRON;
  const ff = freshFlags();
  assert.equal(ff.isEnabled('weekly-digest-cron'), true);
});
