'use strict';

/**
 * Tests for originPolicy.js (#1063).
 *
 * Covers:
 *   - parseOrigin: valid/invalid inputs, subdomains, ports, schemes, normalisation
 *   - checkOrigin: allowlist matching, absent header, malformed origin,
 *                  wildcard, empty list, localhost dev opt-in
 *   - validateAndNormaliseAllowedOrigin: rejects bad input, accepts wildcard
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseOrigin,
  checkOrigin,
  validateAndNormaliseAllowedOrigin,
  LOCAL_DEV_ORIGINS,
} = require('./originPolicy');

// ─────────────────────────────────────────────────────────────────────────────
// parseOrigin
// ─────────────────────────────────────────────────────────────────────────────

test('parseOrigin accepts a simple https origin', () => {
  assert.equal(parseOrigin('https://example.com'), 'https://example.com');
});

test('parseOrigin accepts http', () => {
  assert.equal(parseOrigin('http://example.com'), 'http://example.com');
});

test('parseOrigin normalises to lowercase', () => {
  assert.equal(parseOrigin('https://EXAMPLE.COM'), 'https://example.com');
});

test('parseOrigin strips a trailing slash', () => {
  assert.equal(parseOrigin('https://example.com/'), 'https://example.com');
});

test('parseOrigin strips the default https port (443)', () => {
  assert.equal(parseOrigin('https://example.com:443'), 'https://example.com');
});

test('parseOrigin strips the default http port (80)', () => {
  assert.equal(parseOrigin('http://example.com:80'), 'http://example.com');
});

test('parseOrigin keeps a non-default port', () => {
  assert.equal(parseOrigin('https://example.com:8443'), 'https://example.com:8443');
  assert.equal(parseOrigin('http://example.com:3000'), 'http://example.com:3000');
});

test('parseOrigin accepts a subdomain', () => {
  assert.equal(parseOrigin('https://app.example.com'), 'https://app.example.com');
  assert.equal(parseOrigin('https://a.b.c.example.com'), 'https://a.b.c.example.com');
});

test('parseOrigin accepts a subdomain with non-default port', () => {
  assert.equal(parseOrigin('https://staging.app.example.com:4443'), 'https://staging.app.example.com:4443');
});

test('parseOrigin rejects a URL with a path', () => {
  assert.equal(parseOrigin('https://example.com/path'), null);
});

test('parseOrigin rejects a URL with a query string', () => {
  assert.equal(parseOrigin('https://example.com?foo=bar'), null);
});

test('parseOrigin rejects a URL with a fragment', () => {
  assert.equal(parseOrigin('https://example.com#section'), null);
});

test('parseOrigin rejects ftp and other non-http(s) schemes', () => {
  assert.equal(parseOrigin('ftp://example.com'), null);
  assert.equal(parseOrigin('mailto:user@example.com'), null);
  assert.equal(parseOrigin('data:text/html,hello'), null);
});

test('parseOrigin rejects non-loopback bare IP addresses', () => {
  assert.equal(parseOrigin('http://192.168.1.1'), null);
  assert.equal(parseOrigin('http://10.0.0.1'), null);
  assert.equal(parseOrigin('https://1.2.3.4'), null);
});

test('parseOrigin accepts loopback IP (127.x.x.x)', () => {
  assert.equal(parseOrigin('http://127.0.0.1'), 'http://127.0.0.1');
  assert.equal(parseOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
});

test('parseOrigin rejects empty string', () => {
  assert.equal(parseOrigin(''), null);
});

test('parseOrigin rejects null and undefined', () => {
  assert.equal(parseOrigin(null), null);
  assert.equal(parseOrigin(undefined), null);
});

test('parseOrigin rejects non-string input', () => {
  assert.equal(parseOrigin(42), null);
  assert.equal(parseOrigin({}), null);
});

test('parseOrigin rejects a plain hostname without scheme', () => {
  assert.equal(parseOrigin('example.com'), null);
});

test('parseOrigin rejects malformed strings', () => {
  assert.equal(parseOrigin('not-a-url'), null);
  assert.equal(parseOrigin('://example.com'), null);
  assert.equal(parseOrigin('https://'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// checkOrigin
// ─────────────────────────────────────────────────────────────────────────────

test('checkOrigin allows when Origin header is absent (server-to-server)', () => {
  const result = checkOrigin(null, ['https://example.com']);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'no-origin-header');
});

test('checkOrigin allows when Origin is undefined', () => {
  const result = checkOrigin(undefined, ['https://example.com']);
  assert.equal(result.allowed, true);
});

test('checkOrigin denies a malformed origin', () => {
  const result = checkOrigin('not-an-origin', ['https://example.com']);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'malformed-origin');
});

test('checkOrigin denies a ftp origin (rejected by parseOrigin)', () => {
  const result = checkOrigin('ftp://example.com', ['https://example.com']);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'malformed-origin');
});

test('checkOrigin allows a wildcard entry in the allowlist', () => {
  const result = checkOrigin('https://any.site.example.com', ['*']);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'wildcard');
});

test('checkOrigin denies when the allowlist is empty', () => {
  const result = checkOrigin('https://example.com', []);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'no-allowlist');
});

test('checkOrigin denies when the allowlist is null/undefined', () => {
  assert.equal(checkOrigin('https://example.com', null).allowed, false);
  assert.equal(checkOrigin('https://example.com', undefined).allowed, false);
});

test('checkOrigin allows an exact allowlist match', () => {
  const result = checkOrigin('https://example.com', ['https://example.com']);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'allowlist-match');
});

test('checkOrigin normalises both sides before comparing', () => {
  // Request sends with default port; allowlist stored without it
  const result = checkOrigin('https://example.com:443', ['https://example.com']);
  assert.equal(result.allowed, true);
});

test('checkOrigin is case-insensitive', () => {
  const result = checkOrigin('https://EXAMPLE.COM', ['https://example.com']);
  assert.equal(result.allowed, true);
});

test('checkOrigin rejects a different subdomain', () => {
  const result = checkOrigin('https://evil.example.com', ['https://example.com']);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'not-in-allowlist');
});

test('checkOrigin rejects a different port', () => {
  const result = checkOrigin('https://example.com:8443', ['https://example.com']);
  assert.equal(result.allowed, false);
});

test('checkOrigin allows the correct port when listed', () => {
  const result = checkOrigin('https://example.com:8443', ['https://example.com:8443']);
  assert.equal(result.allowed, true);
});

test('checkOrigin matches a listed subdomain exactly', () => {
  const allowedOrigins = ['https://app.example.com', 'https://www.example.com'];
  assert.equal(checkOrigin('https://app.example.com', allowedOrigins).allowed, true);
  assert.equal(checkOrigin('https://www.example.com', allowedOrigins).allowed, true);
  assert.equal(checkOrigin('https://evil.example.com', allowedOrigins).allowed, false);
});

test('checkOrigin rejects http when only https is listed', () => {
  const result = checkOrigin('http://example.com', ['https://example.com']);
  assert.equal(result.allowed, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// checkOrigin — local development opt-in
// ─────────────────────────────────────────────────────────────────────────────

test('checkOrigin allows localhost when EMBED_ALLOW_LOCALHOST=true in non-production', () => {
  const env = { EMBED_ALLOW_LOCALHOST: 'true', NODE_ENV: 'development' };
  const result = checkOrigin('http://localhost:3000', [], { env });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'localhost-dev');
});

test('checkOrigin allows 127.0.0.1 loopback when opt-in is active', () => {
  const env = { EMBED_ALLOW_LOCALHOST: 'true', NODE_ENV: 'test' };
  const result = checkOrigin('http://127.0.0.1:3001', [], { env });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'localhost-dev');
});

test('checkOrigin does NOT allow localhost without EMBED_ALLOW_LOCALHOST=true', () => {
  const env = { NODE_ENV: 'development' }; // flag absent
  const result = checkOrigin('http://localhost:3000', [], { env });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'no-allowlist');
});

test('checkOrigin does NOT allow localhost in production even with the flag set', () => {
  const env = { EMBED_ALLOW_LOCALHOST: 'true', NODE_ENV: 'production' };
  const result = checkOrigin('http://localhost:3000', [], { env });
  assert.equal(result.allowed, false);
});

test('checkOrigin localhost opt-in does not allow non-loopback origins', () => {
  const env = { EMBED_ALLOW_LOCALHOST: 'true', NODE_ENV: 'development' };
  // Not in LOCAL_DEV_ORIGINS
  const result = checkOrigin('https://staging.example.com', [], { env });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'no-allowlist');
});

test('LOCAL_DEV_ORIGINS covers common Vite and Node dev ports', () => {
  assert.ok(LOCAL_DEV_ORIGINS.has('http://localhost:5173'));
  assert.ok(LOCAL_DEV_ORIGINS.has('http://localhost:3000'));
  assert.ok(LOCAL_DEV_ORIGINS.has('http://localhost:3001'));
});

// ─────────────────────────────────────────────────────────────────────────────
// validateAndNormaliseAllowedOrigin
// ─────────────────────────────────────────────────────────────────────────────

test('validateAndNormaliseAllowedOrigin normalises a valid origin', () => {
  assert.equal(
    validateAndNormaliseAllowedOrigin('https://app.example.com'),
    'https://app.example.com'
  );
});

test('validateAndNormaliseAllowedOrigin strips trailing slash', () => {
  assert.equal(
    validateAndNormaliseAllowedOrigin('https://example.com/'),
    'https://example.com'
  );
});

test('validateAndNormaliseAllowedOrigin strips default port', () => {
  assert.equal(
    validateAndNormaliseAllowedOrigin('https://example.com:443'),
    'https://example.com'
  );
});

test('validateAndNormaliseAllowedOrigin accepts the wildcard "*"', () => {
  assert.equal(validateAndNormaliseAllowedOrigin('*'), '*');
});

test('validateAndNormaliseAllowedOrigin throws on a URL with a path', () => {
  assert.throws(
    () => validateAndNormaliseAllowedOrigin('https://example.com/some/path'),
    /not a valid origin/
  );
});

test('validateAndNormaliseAllowedOrigin throws on a bare hostname', () => {
  assert.throws(
    () => validateAndNormaliseAllowedOrigin('example.com'),
    /not a valid origin/
  );
});

test('validateAndNormaliseAllowedOrigin throws on empty string', () => {
  assert.throws(
    () => validateAndNormaliseAllowedOrigin(''),
    /not a valid origin/
  );
});

test('validateAndNormaliseAllowedOrigin throws on a non-http scheme', () => {
  assert.throws(
    () => validateAndNormaliseAllowedOrigin('ftp://example.com'),
    /not a valid origin/
  );
});

test('validateAndNormaliseAllowedOrigin throws on a non-loopback IP', () => {
  assert.throws(
    () => validateAndNormaliseAllowedOrigin('http://192.168.1.1'),
    /not a valid origin/
  );
});

test('validateAndNormaliseAllowedOrigin accepts a non-default port', () => {
  assert.equal(
    validateAndNormaliseAllowedOrigin('https://app.example.com:8443'),
    'https://app.example.com:8443'
  );
});

test('validateAndNormaliseAllowedOrigin accepts localhost (loopback is fine for dev/staging)', () => {
  assert.equal(
    validateAndNormaliseAllowedOrigin('http://localhost:3000'),
    'http://localhost:3000'
  );
});
