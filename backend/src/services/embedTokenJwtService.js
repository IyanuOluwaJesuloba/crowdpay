'use strict';

const jwt = require('jsonwebtoken');

function getJwtSecret() {
  return process.env.JWT_SECRET || 'testsecret';
}

/**
 * Signs a JWT for an embed token.
 * Payload includes sub (campaignId), origins (allowedOrigins), and optionally scope.
 * expiresIn can be '7d', '30d', or 'never'.
 */
function signEmbedToken({ campaignId, allowedOrigins = [], expiresIn = 'never', scope = null }) {
  const payload = {
    sub: campaignId,
    origins: Array.isArray(allowedOrigins) ? allowedOrigins : [],
  };

  if (scope) {
    payload.scope = scope;
  }

  const options = {};
  if (expiresIn === '7d') {
    options.expiresIn = '7d';
  } else if (expiresIn === '30d') {
    options.expiresIn = '30d';
  }
  // 'never' does not set an exp claim

  return jwt.sign(payload, getJwtSecret(), options);
}

/**
 * Verifies a JWT embed token.
 * Returns the decoded payload or null if invalid/expired.
 */
function verifyEmbedToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}

/**
 * Validates request origin against allowedOrigins.
 * Rejects if origin is missing or not included in allowedOrigins (unless wildcard '*' is present).
 */
function validateOrigin(originHeader, allowedOrigins = []) {
  if (!originHeader || typeof originHeader !== 'string') return false;
  if (!Array.isArray(allowedOrigins)) return false;

  if (allowedOrigins.includes('*')) return true;

  const normalizedOrigin = originHeader.trim().replace(/\/+$/, '').toLowerCase();
  return allowedOrigins.some((allowed) => {
    if (allowed === '*') return true;
    if (typeof allowed !== 'string') return false;
    const normalizedAllowed = allowed.trim().replace(/\/+$/, '').toLowerCase();
    return normalizedOrigin === normalizedAllowed;
  });
}

/**
 * Signs a JWT for a milestone progress widget embed token.
 * This token is scoped to read-only milestone access for external embedding.
 */
function signMilestoneWidgetToken({ campaignId, allowedOrigins = [], expiresIn = 'never' }) {
  return signEmbedToken({
    campaignId,
    allowedOrigins,
    expiresIn,
    scope: 'milestones:read',
  });
}

module.exports = {
  signEmbedToken,
  verifyEmbedToken,
  validateOrigin,
  signMilestoneWidgetToken,
};
