const express = require('express');
const router = express.Router();
const {
  getAllProposals,
  getProposalById,
  checkUserTokenBalance,
  getUserTokenBalance,
  getEffectiveVoteWeight,
  setVoteDelegation,
  revokeVoteDelegation,
  getDelegateForWallet,
  createProposal,
  voteOnProposal,
  executeProposal,
  syncProposalData,
} = require('../services/governance');
const {
  getFeeRegistryInfo,
  invalidateFeeCache,
} = require('../services/feeRegistry');
const { requireAuth } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');
const logger = require('../config/logger');

/**
 * GET /api/governance/proposals
 * List all proposals (active and historical)
 */
router.get('/proposals', async (req, res, next) => {
  try {
    const proposals = await getAllProposals();
    res.json({ proposals });
  } catch (error) {
    logger.error('Failed to get proposals', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/governance/proposals/:id
 * Get single proposal detail with votes and outcome projection
 */
router.get('/proposals/:id', 
  param('id').isUUID(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const proposal = await getProposalById(req.params.id);
      
      if (!proposal) {
        return res.status(404).json({ error: 'Proposal not found' });
      }

      res.json({ proposal });
    } catch (error) {
      logger.error('Failed to get proposal', { error: error.message, proposalId: req.params.id });
      next(error);
    }
  }
);

/**
 * POST /api/governance/proposals/:id/vote
 * User votes on a proposal
 */
router.post('/proposals/:id/vote',
  requireAuth,
  param('id').isUUID(),
  body('in_favor').isBoolean(),
  body('signer_secret').isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { in_favor, signer_secret } = req.body;
      const voterPublicKey = req.user.wallet_public_key;

      const result = await voteOnProposal(
        req.params.id,
        voterPublicKey,
        in_favor,
        signer_secret
      );

      res.json({ success: true, vote: result });
    } catch (error) {
      logger.error('Failed to vote on proposal', { error: error.message, proposalId: req.params.id });
      
      if (error.message.includes('not active') || error.message.includes('not found')) {
        return res.status(400).json({ error: error.message });
      }
      if (error.message.includes('must hold')) {
        return res.status(403).json({ error: error.message });
      }
      
      next(error);
    }
  }
);

/**
 * POST /api/governance/proposals
 * Create a new proposal (gated by token balance check)
 */
router.post('/proposals',
  requireAuth,
  body('new_fee_bps').isInt({ min: 0, max: 10000 }),
  body('new_creator_share_bps').isInt({ min: 0, max: 10000 }),
  body('rationale_text').isString().isLength({ min: 10, max: 1000 }),
  body('signer_secret').isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { new_fee_bps, new_creator_share_bps, rationale_text, signer_secret } = req.body;
      const proposerPublicKey = req.user.wallet_public_key;

      // Check token balance before creating proposal
      const hasTokens = await checkUserTokenBalance(proposerPublicKey);
      if (!hasTokens) {
        return res.status(403).json({ 
          error: 'Proposer must hold at least 1,000 governance tokens' 
        });
      }

      const proposal = await createProposal(
        proposerPublicKey,
        new_fee_bps,
        new_creator_share_bps,
        rationale_text,
        signer_secret
      );

      res.status(201).json({ success: true, proposal });
    } catch (error) {
      logger.error('Failed to create proposal', { error: error.message });
      
      if (error.message.includes('must hold')) {
        return res.status(403).json({ error: error.message });
      }
      
      next(error);
    }
  }
);

/**
 * POST /api/governance/proposals/:id/execute
 * Execute a proposal (after deadline)
 */
router.post('/proposals/:id/execute',
  requireAuth,
  param('id').isUUID(),
  body('signer_secret').isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { signer_secret } = req.body;

      const result = await executeProposal(req.params.id, signer_secret);

      // Invalidate fee cache after successful execution
      if (result.status === 'executed') {
        invalidateFeeCache();
      }

      res.json({ success: true, execution: result });
    } catch (error) {
      logger.error('Failed to execute proposal', { error: error.message, proposalId: req.params.id });
      
      if (error.message.includes('not active') || error.message.includes('not found')) {
        return res.status(400).json({ error: error.message });
      }
      
      next(error);
    }
  }
);

/**
 * GET /api/governance/fee
 * Get current fee from cache + contract ID for verification
 */
router.get('/fee', async (req, res, next) => {
  try {
    const feeInfo = await getFeeRegistryInfo();
    res.json(feeInfo);
  } catch (error) {
    logger.error('Failed to get fee info', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/governance/user/token-balance
 * Get current user's governance token balance
 */
router.get('/user/token-balance', requireAuth, async (req, res, next) => {
  try {
    const publicKey = req.user.wallet_public_key;
    const balance = await getUserTokenBalance(publicKey);
    const canPropose = balance >= 1000;

    res.json({
      balance,
      can_propose: canPropose,
      min_required: 1000,
    });
  } catch (error) {
    logger.error('Failed to get user token balance', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/governance/sync
 * Sync proposal data from on-chain (admin/internal use)
 */
router.post('/sync', async (req, res, next) => {
  try {
    await syncProposalData();
    res.json({ success: true, message: 'Proposal data synced' });
  } catch (error) {
    logger.error('Failed to sync proposal data', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/governance/user/vote-weight
 * Get the current user's effective vote weight, including delegated power (#735).
 */
router.get('/user/vote-weight', requireAuth, async (req, res, next) => {
  try {
    const publicKey = req.user.wallet_public_key;
    const [weight, delegate] = await Promise.all([
      getEffectiveVoteWeight(publicKey),
      getDelegateForWallet(publicKey),
    ]);

    res.json({
      effective_vote_weight: weight,
      own_balance: await getUserTokenBalance(publicKey),
      delegate_public_key: delegate ? delegate.delegate_public_key : null,
    });
  } catch (error) {
    logger.error('Failed to get effective vote weight', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/governance/delegations
 * Get the current user's active delegation edge (if any).
 */
router.get('/delegations', requireAuth, async (req, res, next) => {
  try {
    const delegate = await getDelegateForWallet(req.user.wallet_public_key);
    res.json({ delegation: delegate });
  } catch (error) {
    logger.error('Failed to get delegation', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/governance/delegations
 * Delegate the current user's governance voting power to another wallet.
 */
router.post('/delegations',
  requireAuth,
  body('delegate_public_key').isString().notEmpty(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const delegation = await setVoteDelegation(
        req.user.wallet_public_key,
        req.body.delegate_public_key
      );
      res.status(201).json({ success: true, delegation });
    } catch (error) {
      if (error.code === 'INVALID_DELEGATION') {
        return res.status(400).json({ error: error.message });
      }
      logger.error('Failed to set delegation', { error: error.message });
      next(error);
    }
  }
);

/**
 * DELETE /api/governance/delegations
 * Revoke the current user's vote delegation.
 */
router.delete('/delegations', requireAuth, async (req, res, next) => {
  try {
    const removed = await revokeVoteDelegation(req.user.wallet_public_key);
    res.json({ success: true, revoked: removed });
  } catch (error) {
    logger.error('Failed to revoke delegation', { error: error.message });
    next(error);
  }
});

module.exports = router;
