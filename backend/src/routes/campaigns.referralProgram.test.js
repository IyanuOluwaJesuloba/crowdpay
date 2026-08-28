const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { Keypair } = require('@stellar/stellar-sdk');

if (!process.env.PLATFORM_SECRET_KEY) {
  process.env.PLATFORM_SECRET_KEY = Keypair.random().secret();
}
if (!process.env.USDC_ISSUER) {
  process.env.USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
}

function buildApp({ queryImpl = async () => ({ rows: [] }), referralStub = {}, authUser }) {
  const router = proxyquire('./campaigns', {
    '../services/campaignStatusService': {
      refreshCampaignStatus: async () => ({ failed: null, funded: null }),
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
    '../services/campaignStatusActions': {
      queueFailedCampaignRefunds: async () => ({ refundsCreated: 0, refunds: [] }),
    },
    '../config/database': {
      query: queryImpl,
      connect: async () => ({ query: queryImpl, release: async () => {} }),
    },
    '../services/referral': {
      createReferralProgram: async () => ({}),
      createReferralLink: async () => ({}),
      getReferralProgram: async () => null,
      listCampaignReferrers: async () => ({ program: null, referrers: [] }),
      ...referralStub,
    },
    '../services/stellarService': {
      createCampaignWallet: async () => ({ publicKey: 'GPK', secret: 'S' }),
      getCampaignBalance: async () => ({}),
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
      buildWithdrawalTransaction: async () => '',
    },
    '../services/ledgerMonitor': { watchCampaignWallet: async () => {} },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: async () => 'tx-row',
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '../services/sorobanService': {
      deployCampaignContracts: async () => ({ escrowContractId: 'C', milestonesContractId: 'C' }),
      invokeContract: async () => null,
      encodeMilestone: () => ({}),
      nativeToScVal: (v) => v,
      scvAddressFromString: (s) => s,
    },
    '../services/emailService': { sendEmail: async () => {} },
    '../services/alerting': { sendAlert: () => {} },
    '../services/walletService': { encryptSecret: () => 'encrypted-secret' },
    '../services/webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      WEBHOOK_EVENTS: {},
    },
    '../services/storage': { uploadCampaignCoverImage: async () => '/images/cover.jpg' },
    '../services/kycProvider': { isKycRequiredForCampaigns: () => false },
    '../services/userDashboardService': { listCreatorCampaigns: async () => [] },
    '../services/campaignAnalyticsService': {
      getCampaignAnalytics: async () => ({}),
      getCampaignContributors: async () => ({}),
    },
    '../middleware/validation': {
      createCampaignValidation: [],
      createCampaignUpdateValidation: [],
      getCampaignsValidation: [],
      validateRequest: (_req, _res, next) => next(),
    },
    '../utils/asyncHandler': (fn) => (req, res, next) => fn(req, res, next).catch(next),
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = authUser || { userId: 'creator-1', role: 'creator' };
        next();
      },
      requireRole: () => (_req, _res, next) => next(),
      optionalAuth: (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/campaigns', router);
  return app;
}

const ownerQuery = async (text) => {
  if (text.includes('SELECT creator_id FROM campaigns')) {
    return { rows: [{ creator_id: 'creator-1' }] };
  }
  return { rows: [] };
};

test('POST /api/campaigns/:id/referrals enables referrals for the campaign', async () => {
  let received;
  const app = buildApp({
    queryImpl: ownerQuery,
    referralStub: {
      createReferralProgram: async (campaignId, options) => {
        received = { campaignId, options };
        return {
          id: 'prog-1',
          campaign_id: campaignId,
          commission_percentage: '5.00',
          max_referrers: 10,
        };
      },
    },
  });

  const response = await request(app)
    .post('/api/campaigns/camp-1/referrals')
    .set('Authorization', 'Bearer token')
    .send({ commissionPercentage: 5, maxReferrers: 10 });

  assert.equal(response.status, 201);
  assert.equal(response.body.id, 'prog-1');
  assert.equal(received.campaignId, 'camp-1');
  assert.deepEqual(received.options, { commissionPercentage: 5, maxReferrers: 10 });
});

test('POST /api/campaigns/:id/referrals rejects an out-of-range commission percentage', async () => {
  const app = buildApp({
    queryImpl: ownerQuery,
    referralStub: {
      createReferralProgram: async () => {
        const err = new Error('commissionPercentage must be between 1 and 20');
        err.statusCode = 400;
        err.code = 'INVALID_COMMISSION_PERCENTAGE';
        throw err;
      },
    },
  });

  const response = await request(app)
    .post('/api/campaigns/camp-1/referrals')
    .set('Authorization', 'Bearer token')
    .send({ commissionPercentage: 50, maxReferrers: 10 });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'INVALID_COMMISSION_PERCENTAGE');
});

test('POST /api/campaigns/:id/referrals/links returns a code and share url', async () => {
  const app = buildApp({
    authUser: { userId: 'user-9', role: 'contributor' },
    referralStub: {
      createReferralLink: async ({ campaignId, userId }) => {
        assert.equal(campaignId, 'camp-1');
        assert.equal(userId, 'user-9');
        return {
          created: true,
          code: 'a1b2c3d4',
          shareUrl: 'http://localhost:5173/c/camp-1?ref=a1b2c3d4',
        };
      },
    },
  });

  const response = await request(app)
    .post('/api/campaigns/camp-1/referrals/links')
    .set('Authorization', 'Bearer token')
    .send({});

  assert.equal(response.status, 201);
  assert.equal(response.body.code, 'a1b2c3d4');
  assert.equal(response.body.shareUrl, 'http://localhost:5173/c/camp-1?ref=a1b2c3d4');
});

test('POST /api/campaigns/:id/referrals/links returns 409 once maxReferrers is reached', async () => {
  const app = buildApp({
    authUser: { userId: 'user-11', role: 'contributor' },
    referralStub: {
      createReferralLink: async () => {
        const err = new Error('This campaign has reached its limit of 10 referrers');
        err.statusCode = 409;
        err.code = 'REFERRER_LIMIT_REACHED';
        throw err;
      },
    },
  });

  const response = await request(app)
    .post('/api/campaigns/camp-1/referrals/links')
    .set('Authorization', 'Bearer token')
    .send({});

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'REFERRER_LIMIT_REACHED');
});

test('GET /api/campaigns/:id/referrals/commissions returns the referrer breakdown to the owner', async () => {
  const app = buildApp({
    queryImpl: ownerQuery,
    referralStub: {
      listCampaignReferrers: async () => ({
        program: { commission_percentage: 10, max_referrers: 10, referrer_count: 1 },
        referrers: [
          {
            code: 'a1b2c3d4',
            referrer_name: 'Alice',
            contribution_count: 2,
            referred_amount: '600.0000000',
            commission_owed: '60.0000000',
          },
        ],
      }),
    },
  });

  const response = await request(app)
    .get('/api/campaigns/camp-1/referrals/commissions')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.referrers.length, 1);
  assert.equal(response.body.referrers[0].commission_owed, '60.0000000');
});

test('GET /api/campaigns/:id/referrals/commissions 404s when referrals are not enabled', async () => {
  const app = buildApp({ queryImpl: ownerQuery });

  const response = await request(app)
    .get('/api/campaigns/camp-1/referrals/commissions')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 404);
});
