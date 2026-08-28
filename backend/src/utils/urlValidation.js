'use strict';

const ALLOWED_SCHEMES = new Set(['https:']);
const DEV_ALLOWED_SCHEMES = new Set(['https:', 'http:']);

/**
 * Validate that a URL is safe for rendering as src/href.
 *
 * Only HTTPS is allowed in production. HTTP is permitted for localhost/127.0.0.1/::1
 * in non-production environments. Dangerous schemes (javascript:, data:, vbscript:, etc.)
 * are always rejected.
 *
 * @param {string} urlString
 * @param {object} [options]
 * @param {boolean} [options.allowLocalhostHttp] - allow http://localhost (default: NODE_ENV !== 'production')
 * @returns {{ safe: boolean, reason: string, normalized: string }}
 */
function validateRenderUrl(urlString, options = {}) {
  if (typeof urlString !== 'string' || !urlString.trim()) {
    return { safe: false, reason: 'URL is required', normalized: '' };
  }

  const trimmed = urlString.trim();

  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return { safe: false, reason: 'Invalid URL format', normalized: '' };
  }

  const allowLocalhostHttp = options.allowLocalhostHttp !== undefined
    ? options.allowLocalhostHttp
    : process.env.NODE_ENV !== 'production';

  const allowedSchemes = allowLocalhostHttp ? DEV_ALLOWED_SCHEMES : ALLOWED_SCHEMES;

  if (!allowedSchemes.has(u.protocol)) {
    return {
      safe: false,
      reason: `URL scheme "${u.protocol}" is not allowed. Only HTTPS is permitted${allowLocalhostHttp ? ' (HTTP allowed for localhost in development)' : ''}`,
      normalized: '',
    };
  }

  if (u.protocol === 'http:') {
    const host = u.hostname.toLowerCase();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!isLocalhost) {
      return {
        safe: false,
        reason: 'HTTP is only allowed for localhost/127.0.0.1 in development',
        normalized: '',
      };
    }
  }

  const normalized = u.href;

  return { safe: true, reason: '', normalized };
}

/**
 * Express middleware factory that validates a body field as a safe render URL.
 *
 * @param {string} fieldName - body field to validate (e.g. 'evidence_url')
 * @param {object} [options]
 * @param {boolean} [options.required] - if true, returns 400 when missing (default: false)
 * @returns {Function} Express middleware
 */
function requireValidRenderUrl(fieldName, options = {}) {
  return (req, res, next) => {
    const value = req.body?.[fieldName];

    if (!value || (typeof value === 'string' && !value.trim())) {
      if (options.required) {
        return res.status(400).json({ error: `${fieldName} is required` });
      }
      return next();
    }

    const { safe, reason, normalized } = validateRenderUrl(value, {
      allowLocalhostHttp: process.env.NODE_ENV !== 'production',
    });

    if (!safe) {
      return res.status(422).json({ error: `${fieldName} is not valid: ${reason}` });
    }

    req.body[fieldName] = normalized;
    next();
  };
}

module.exports = { validateRenderUrl, requireValidRenderUrl };
