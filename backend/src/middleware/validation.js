const { body, param, query, validationResult } = require('express-validator');
const { Keypair } = require('@stellar/stellar-sdk');
const { getSupportedAssetCodes } = require('../services/stellarService');
const { stripHtml, sanitizeRichText } = require('../lib/sanitize');

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const VALID_CAMPAIGN_STATUSES = ['active', 'funded', 'closed', 'failed'];
const VALID_ORDER_BY = ['newest', 'ending_soon', 'most_funded', 'most_backed', 'closest_to_goal', 'trending', 'relevance'];
const VALID_CATEGORIES = [
  'technology', 'community', 'arts', 'education',
  'environment', 'health', 'business', 'open_source', 'other',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function blankToNull(value) {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

const passwordValidation = [
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[a-z]/)
    .withMessage('Password must include a lowercase letter')
    .matches(/[A-Z]/)
    .withMessage('Password must include an uppercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must include a number'),
];

const registerValidation = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Invalid email format'),
  ...passwordValidation,
  body('name')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Name is required'),
  body('wallet_type')
    .optional()
    .isIn(['custodial', 'freighter'])
    .withMessage('wallet_type must be custodial or freighter'),
  body('wallet_public_key')
    .optional()
    .custom((value, { req }) => {
      if (req.body.wallet_type === 'freighter') {
        try {
          Keypair.fromPublicKey(value);
          return true;
        } catch (_err) {
          throw new Error('wallet_public_key must be a valid Stellar public key');
        }
      }
      return true;
    }),
  body('role')
    .optional()
    .isIn(['contributor', 'creator'])
    .withMessage('Role must be contributor or creator'),
];

const loginValidation = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Invalid email format'),
  body('password').notEmpty().withMessage('Password is required'),
];

const forgotPasswordValidation = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Invalid email format'),
];

const resetPasswordValidation = [
  body('token').notEmpty().withMessage('Reset token is required'),
  ...passwordValidation,
];

const validateDeadline = (value) => {
  if (!value) return true;
  const deadline = new Date(value);
  const now = new Date();
  const minFutureTime = now.getTime() + 24 * 60 * 60 * 1000;
  if (isNaN(deadline.getTime()) || deadline.getTime() < minFutureTime) {
    throw new Error('Deadline must be at least 24 hours in the future');
  }
  return true;
};

const createCampaignValidation = [
  body('title')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Title is required')
    .isLength({ max: 100 })
    .withMessage('Title must be at most 100 characters'),
  body('category')
    .optional({ nullable: true })
    .customSanitizer(stripHtml)
    .isLength({ max: 50 })
    .withMessage('Category must be at most 50 characters'),
  body('description')
    .optional({ nullable: true })
    .customSanitizer(sanitizeRichText)
    .isLength({ max: 1000 })
    .withMessage('Description must be at most 1000 characters'),
  body('target_amount')
    .exists()
    .withMessage('Target amount is required')
    .isFloat({ gt: 0 })
    .withMessage('Target amount must be greater than zero'),
  body('asset_type')
    .notEmpty()
    .withMessage('Asset type is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`Asset type must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  body('template_id')
    .optional({ nullable: true, checkFalsy: true })
    .custom(isUuid)
    .withMessage('template_id must be a valid UUID'),
  body('deadline')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('Deadline must be a valid ISO 8601 date (preferably with Z suffix for UTC)')
    .custom(validateDeadline),
  body('min_contribution')
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ gt: 0 })
    .withMessage('Minimum contribution must be greater than zero'),
];

const updateCampaignValidation = [
  body('deadline')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('Deadline must be a valid ISO 8601 date')
    .custom(validateDeadline),
];

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg, errors: errors.array() });
  }
  next();
};

module.exports = {
  registerValidation,
  loginValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  createCampaignValidation,
  updateCampaignValidation,
  handleValidationErrors,
  isUuid,
  blankToNull,
  CAMPAIGN_UPDATE_BODY_MAX_LENGTH: 5000,
};