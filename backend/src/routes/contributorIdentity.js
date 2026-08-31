/**
 * Contributor Identity routes — issue #689
 *
 * POST   /api/contributor/identity/register           authenticated; idempotent
 * GET    /api/contributor/identity/:publicKey          public
 * GET    /api/contributor/identity/:publicKey/verify   public; ?attestation=kyc_standard
 */

const router = require('express').Router();
const { param, query, validationResult } = require('express-validator');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../config/logger');
const db = require('../config/database');
const {
  registerIdentity,
  getContributorProfile,
  verifyAttestation,
} = require('../services/contributorIdentityService');

const VALID_ATTESTATION_TYPES = ['kyc_basic', 'kyc_standard', 'kyc_enhanced'];

function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request parameters',
        fields: Object.fromEntries(errors.array().map((e) => [e.path, e.msg])),
      },
    });
  }
  next();
}

/**
 * POST /api/contributor/identity/register
 *
 * Register the authenticated user's Stellar public key on the identity
 * contract and in the contributor_identities table.  Idempotent.
 */
router.post(
  '/register',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req.user;

    // Fetch the user's wallet public key
    const { rows } = await db.query(
      'SELECT wallet_public_key FROM users WHERE id = $1',
      [userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const publicKey = rows[0].wallet_public_key;
    if (!publicKey) {
      return res.status(400).json({ error: 'User does not have a Stellar wallet linked' });
    }

    const identity = await registerIdentity(publicKey, userId);

    res.status(200).json({
      did: identity.did,
      public_key: identity.public_key,
      contract_registered_at: identity.contract_registered_at,
      created_at: identity.created_at,
    });
  })
);

/**
 * GET /api/contributor/identity/:publicKey
 *
 * Public endpoint.  Returns DID, reputation score, attestation types (no PII),
 * and aggregated contribution stats.
 */
router.get(
  '/:publicKey',
  [
    param('publicKey')
      .isString()
      .trim()
      .matches(/^G[A-Z2-7]{55}$/)
      .withMessage('publicKey must be a valid Stellar public key'),
  ],
  validateRequest,
  asyncHandler(async (req, res) => {
    const { publicKey } = req.params;
    const profile = await getContributorProfile(publicKey);
    res.json(profile);
  })
);

/**
 * GET /api/contributor/identity/:publicKey/verify?attestation=kyc_standard
 *
 * Used by campaign creators to gate contributions based on KYC level without
 * accessing personal data.  Returns { verified, expiresAt }.
 */
router.get(
  '/:publicKey/verify',
  [
    param('publicKey')
      .isString()
      .trim()
      .matches(/^G[A-Z2-7]{55}$/)
      .withMessage('publicKey must be a valid Stellar public key'),
    query('attestation')
      .isIn(VALID_ATTESTATION_TYPES)
      .withMessage(`attestation must be one of: ${VALID_ATTESTATION_TYPES.join(', ')}`),
  ],
  validateRequest,
  asyncHandler(async (req, res) => {
    const { publicKey } = req.params;
    const attestationType = req.query.attestation;
    const result = await verifyAttestation(publicKey, attestationType);
    res.json(result);
  })
);

module.exports = router;
