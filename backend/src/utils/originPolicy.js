'use strict';

/**
 * Origin policy for embeddable widgets (#1063).
 *
 * All embed-token and widget API requests are checked here before any
 * campaign data is returned.  The rules are:
 *
 *   1. Monetary amounts convert once at a validated boundary — but for
 *      origins the equivalent rule is: normalise once (parseOrigin) and
 *      compare normalised values everywhere.
 *
 *   2. An empty allowlist means the campaign owner has not configured any
 *      approved origins.  We treat that as "deny all" in production and
 *      "allow same-host requests" in development (see LOCAL_DEV_ORIGINS).
 *
 *   3. The special value `"*"` in an allowlist entry opts the whole campaign
 *      into wildcard access.  This is stored explicitly so owners can see
 *      they chose it; it is never the default.
 *
 *   4. Local development has a bounded opt-in via EMBED_ALLOW_LOCALHOST=true.
 *      Only the loopback origins listed in LOCAL_DEV_ORIGINS are unlocked —
 *      there is no blanket allow-all.
 */

const LOCAL_DEV_ORIGINS = new Set([
  'http://localhost',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:4000',
  'http://localhost:5173', // Vite default
  'http://127.0.0.1',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:4000',
  'http://127.0.0.1:5173',
]);

/**
 * Normalise an origin string to a canonical form suitable for storage and
 * comparison: lowercase, scheme + host + (port if non-default), no trailing
 * slash, no path.
 *
 * Returns null when the input is not a valid, absolute HTTP/HTTPS origin.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function parseOrigin(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // Only http and https are valid origins for web embeds.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // Reject anything with a path, query, or fragment — origins have none.
  // (We only reject a path that is non-empty; the root '/' is fine to supply
  //  but gets stripped.)
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search || url.hash) return null;

  // Reject bare IP addresses other than loopback (loopback is fine for dev).
  // IPv4: reject non-loopback routable IPs in origin strings.
  // We allow hostnames unconditionally — punycode domains are fine.
  const host = url.hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map(Number);
    const isLoopback = parts[0] === 127;
    if (!isLoopback) return null;
  }

  // Build canonical form: strip default port.
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  const portPart =
    url.port && url.port !== defaultPort ? `:${url.port}` : '';

  return `${url.protocol}//${host}${portPart}`;
}

/**
 * Check whether `requestOrigin` is permitted by `allowedOrigins`.
 *
 * @param {string|null|undefined} requestOrigin  - The Origin request header value.
 * @param {string[]}              allowedOrigins - Campaign's approved origins list.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ allowed: boolean, reason: string }}
 */
function checkOrigin(requestOrigin, allowedOrigins, { env = process.env } = {}) {
  // --- No Origin header ---
  // Browsers always send Origin for cross-origin fetches initiated from inside
  // a page (XHR, fetch, form POST).  A missing Origin means either:
  //   a) a same-origin request (e.g. curl, server-to-server) — allow, because
  //      CSRF is not the concern here; token possession is.
  //   b) a browser request where the browser deliberately omits Origin (very
  //      rare; only happens for navigation requests, not XHR/fetch).
  // We allow absent Origin so that server-side integrations that legitimately
  // use embed tokens are not broken.  The token itself is still required.
  if (!requestOrigin) {
    return { allowed: true, reason: 'no-origin-header' };
  }

  const normalised = parseOrigin(requestOrigin);
  if (!normalised) {
    return { allowed: false, reason: 'malformed-origin' };
  }

  // --- Wildcard entry ---
  if (Array.isArray(allowedOrigins) && allowedOrigins.includes('*')) {
    return { allowed: true, reason: 'wildcard' };
  }

  // --- Local development opt-in ---
  // Only active when EMBED_ALLOW_LOCALHOST=true AND we are not in production.
  const localhostOptIn =
    env.EMBED_ALLOW_LOCALHOST === 'true' && env.NODE_ENV !== 'production';
  if (localhostOptIn && LOCAL_DEV_ORIGINS.has(normalised)) {
    return { allowed: true, reason: 'localhost-dev' };
  }

  // --- Empty allowlist ---
  // No origins configured → deny.  Owners must explicitly allow at least one
  // origin before the embed works from a browser.
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    return { allowed: false, reason: 'no-allowlist' };
  }

  // --- Exact match against normalised allowlist entries ---
  const matched = allowedOrigins.some(entry => {
    if (typeof entry !== 'string') return false;
    if (entry === '*') return true; // redundant safety net
    return parseOrigin(entry) === normalised;
  });

  if (matched) return { allowed: true, reason: 'allowlist-match' };
  return { allowed: false, reason: 'not-in-allowlist' };
}

/**
 * Validate a raw origin string supplied by a campaign owner as part of their
 * allowlist configuration.  Returns the normalised form on success, or throws
 * an Error with a user-facing message on failure.
 *
 * @param {string} raw
 * @returns {string} normalised origin
 */
function validateAndNormaliseAllowedOrigin(raw) {
  if (raw === '*') return '*'; // explicit wildcard is allowed

  const normalised = parseOrigin(raw);
  if (!normalised) {
    throw new Error(
      `"${raw}" is not a valid origin.  Provide an absolute URL with scheme and host, ` +
        `e.g. "https://app.example.com" or "http://localhost:3000".`
    );
  }
  return normalised;
}

module.exports = {
  parseOrigin,
  checkOrigin,
  validateAndNormaliseAllowedOrigin,
  LOCAL_DEV_ORIGINS,
};
