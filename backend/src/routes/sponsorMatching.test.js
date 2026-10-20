const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const request = require('supertest');
const express = require('express');

const CAMPAIGN_UUID = '11111111-1111-4111-8111-111111111111';
const MATCH_UUID = '33333333-3333-4333-8333-333333333333';

class StubDuplicateMatchingPledgeError extends Error {
  constructor() {
    super('Sponsor already has an active matching pledge for this campaign');
    this.code = 'DUPLICATE_MATCHING_PLEDGE';
  }
}

function buildRouters({ queryImpl, serviceImpl }) {
  const dbStub = { query: queryImpl || (async () => ({ rows: [] })) };
  const webhookEvents = [];

  const serviceStub = {
    createMatchingPledge: async () => {
      throw new Error('unmocked');
    },
    getCampaignMatchProgress: async () => ({
      campaignId: CAMPAIGN_UUID,
      matches: [],
      totalPledged: '0.0000000',
      totalMatched: '0.0000000',
      remainingPoolAmount: '0.0000000',
      activePoolCount: 0,
      exhaustedPoolCount: 0,
      percentageUsed: '0.00',
    }),
    completeMatchingPledge: async () => ({}),
    getSponsorMatchingPledges: async () => [],
    DuplicateMatchingPledgeError: StubDuplicateMatchingPledgeError,
    ...serviceImpl,
  };

  const auditCalls = [];

  const routers = proxyquire('./sponsorMatching', {
    '../config/database': dbStub,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-uuid-1' };
        next();
      },
    },
    '../config/logger': {
      info: () => {},
      error: () => {},
      warn: () => {},
    },
    '../services/sponsorMatchingService': serviceStub,
    '../services/auditService': {
      logAuditEvent: async payload => {
        auditCalls.push(payload);
        return { id: 'audit-1' };
      },
    },
    '../services/webhookDispatcher': {
      emitWebhookEventForCampaign: async (...args) => {
        webhookEvents.push(args);
      },
      WEBHOOK_EVENTS: {
        SPONSOR_MATCH_CREATED: 'sponsor_match.created',
        SPONSOR_MATCH_COMPLETED: 'sponsor_match.completed',
      },
    },
  });

  return { ...routers, auditCalls, webhookEvents };
}

function buildApp(router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 'user-uuid-1' };
    next();
  });
  app.use('/', router);
  return app;
}

test('POST /campaigns/:id/matches creates a matching pledge', async () => {
  const mockPledge = {
    id: MATCH_UUID,
    campaign_id: CAMPAIGN_UUID,
    sponsor_user_id: 'user-uuid-1',
    match_ratio: '1.00',
    pledge_amount: '1000.0000000',
    matched_amount: '0.0000000',
    status: 'active',
    created_at: '2026-08-01T00:00:00.000Z',
  };

  const { campaignRouter, auditCalls } = buildRouters({
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_UUID, status: 'active' }] };
      }
      return { rows: [] };
    },
    serviceImpl: {
      createMatchingPledge: async () => mockPledge,
    },
  });

  const res = await request(buildApp(campaignRouter))
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 1.0, pledge_amount: '1000' });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, mockPledge);
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].action, 'sponsor_match.created');
  assert.equal(auditCalls[0].resourceId, MATCH_UUID);
});

test('POST /campaigns/:id/matches returns 404 when campaign not found', async () => {
  const { campaignRouter } = buildRouters({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(buildApp(campaignRouter))
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 1.0, pledge_amount: '1000' });

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Campaign not found' });
});

test('POST /campaigns/:id/matches returns 409 for a closed campaign', async () => {
  const { campaignRouter } = buildRouters({
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_UUID, status: 'completed' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(buildApp(campaignRouter))
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 1.0, pledge_amount: '1000' });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CAMPAIGN_NOT_MATCHABLE');
});

test('POST /campaigns/:id/matches validates positive match ratio', async () => {
  const { campaignRouter } = buildRouters({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(buildApp(campaignRouter))
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: -1, pledge_amount: '1000' });

  assert.equal(res.status, 400);
  assert.ok(res.body.errors);
});

test('POST /campaigns/:id/matches rejects an out-of-range match ratio', async () => {
  const { campaignRouter } = buildRouters({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(buildApp(campaignRouter))
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 5000, pledge_amount: '1000' });

  assert.equal(res.status, 400);
});

test('POST /campaigns/:id/matches validates positive pledge amount', async () => {
  const { campaignRouter } = buildRouters({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(buildApp(campaignRouter))
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 1.0, pledge_amount: '0' });

  assert.equal(res.status, 400);
});

test('POST /campaigns/:id/matches rejects a pledge_amount with 8 decimal places', async () => {
  const { campaignRouter } = buildRouters({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(buildApp(campaignRouter))
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 1.0, pledge_amount: '1.00000001' });

  assert.equal(res.status, 400);
});

test('POST /campaigns/:id/matches accepts a fractional pledge_amount', async () => {
  const mockPledge = {
    id: MATCH_UUID,
    campaign_id: CAMPAIGN_UUID,
    sponsor_user_id: 'user-uuid-1',
    match_ratio: '1.00',
    pledge_amount: '0.3000000',
    matched_amount: '0.0000000',
    status: 'active',
    created_at: '2026-08-01T00:00:00.000Z',
  };

  const { campaignRouter } = buildRouters({
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_UUID, status: 'active' }] };
      }
      return { rows: [] };
    },
    serviceImpl: {
      createMatchingPledge: async () => mockPledge,
    },
  });

  const res = await request(buildApp(campaignRouter))
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 1.0, pledge_amount: '0.3' });

  assert.equal(res.status, 201);
  assert.equal(res.body.pledge_amount, '0.3000000');
});

test('POST /campaigns/:id/matches rejects an invalid campaign id', async () => {
  const { campaignRouter } = buildRouters({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(buildApp(campaignRouter))
    .post('/not-a-uuid/matches')
    .send({ match_ratio: 1.0, pledge_amount: '1000' });

  assert.equal(res.status, 400);
});

test('POST /campaigns/:id/matches returns 409 for a duplicate active pledge', async () => {
  const { campaignRouter } = buildRouters({
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_UUID, status: 'active' }] };
      }
      return { rows: [] };
    },
    serviceImpl: {
      createMatchingPledge: async () => {
        throw new StubDuplicateMatchingPledgeError();
      },
    },
  });

  const res = await request(buildApp(campaignRouter))
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 1.0, pledge_amount: '1000' });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'DUPLICATE_MATCHING_PLEDGE');
});

test('GET /campaigns/:id/matches returns campaign matching progress', async () => {
  const { campaignRouter } = buildRouters({
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_UUID }] };
      }
      return { rows: [] };
    },
    serviceImpl: {
      getCampaignMatchProgress: async () => ({
        campaignId: CAMPAIGN_UUID,
        matches: [],
        totalPledged: '1000.0000000',
        totalMatched: '300.0000000',
        remainingPoolAmount: '700.0000000',
        activePoolCount: 1,
        exhaustedPoolCount: 0,
        percentageUsed: '30.00',
      }),
    },
  });

  const res = await request(buildApp(campaignRouter)).get(`/${CAMPAIGN_UUID}/matches`);

  assert.equal(res.status, 200);
  assert.equal(res.body.totalPledged, '1000.0000000');
  assert.equal(res.body.totalMatched, '300.0000000');
  assert.ok(res.body.matches);
});

test('GET /campaigns/:id/matches returns 404 when campaign not found', async () => {
  const { campaignRouter } = buildRouters({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(buildApp(campaignRouter)).get(`/${CAMPAIGN_UUID}/matches`);

  assert.equal(res.status, 404);
});

test('PATCH completing a matching pledge emits an exact fixed-precision remainder', async () => {
  const { campaignRouter, webhookEvents } = buildRouters({
    queryImpl: async text => {
      if (text.includes('FROM campaign_matches cm')) {
        return { rows: [{ sponsor_user_id: 'user-uuid-1', creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM campaigns')) return { rows: [{ id: CAMPAIGN_UUID }] };
      return { rows: [] };
    },
    serviceImpl: {
      completeMatchingPledge: async () => ({
        id: MATCH_UUID,
        sponsor_user_id: 'sponsor-1',
        pledge_amount: '0.3000000',
        matched_amount: '0.1000000',
      }),
    },
  });

  const res = await request(buildApp(campaignRouter)).patch(
    `/${CAMPAIGN_UUID}/matches/${MATCH_UUID}/complete`
  );

  assert.equal(res.status, 200);
  // 0.3 - 0.1 = 0.2 — must be exact, not 0.19999999999999998.
  assert.equal(webhookEvents[0][2].unclaimed_amount, '0.2000000');
});

test('GET /user/sponsor-matches returns sponsor pledges', async () => {
  const { userRouter } = buildRouters({
    serviceImpl: {
      getSponsorMatchingPledges: async () => [
        {
          id: MATCH_UUID,
          campaignId: 'campaign-1',
          campaignTitle: 'Campaign A',
          campaignStatus: 'active',
          sponsorUserId: 'user-uuid-1',
          sponsorName: 'Sponsor',
          matchRatio: '1.00',
          pledgeAmount: '1000.0000000',
          matchedAmount: '300.0000000',
          remainingAmount: '700.0000000',
          status: 'active',
          contractId: null,
          createdAt: new Date(),
        },
      ],
    },
  });

  const res = await request(buildApp(userRouter)).get('/user/sponsor-matches');

  assert.equal(res.status, 200);
  assert.equal(res.body.pledges.length, 1);
  assert.equal(res.body.pledges[0].pledgeAmount, '1000.0000000');
});

test('PATCH /campaigns/:id/matches/:matchId/complete completes a matching pledge', async () => {
  const { campaignRouter, auditCalls } = buildRouters({
    queryImpl: async text => {
      if (text.includes('FROM campaign_matches cm')) {
        return {
          rows: [
            {
              id: MATCH_UUID,
              campaign_id: CAMPAIGN_UUID,
              sponsor_user_id: 'user-uuid-1',
              creator_id: 'creator-uuid',
              pledge_amount: '1000.0000000',
              matched_amount: '600.0000000',
              status: 'completed',
            },
          ],
        };
      }
      return { rows: [] };
    },
    serviceImpl: {
      completeMatchingPledge: async () => ({
        id: MATCH_UUID,
        campaign_id: CAMPAIGN_UUID,
        sponsor_user_id: 'user-uuid-1',
        pledge_amount: '1000.0000000',
        matched_amount: '600.0000000',
        status: 'completed',
      }),
    },
  });

  const res = await request(buildApp(campaignRouter)).patch(
    `/${CAMPAIGN_UUID}/matches/${MATCH_UUID}/complete`
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'completed');
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].action, 'sponsor_match.completed');
});

test('PATCH /campaigns/:id/matches/:matchId/complete returns 403 when user not authorized', async () => {
  const { campaignRouter } = buildRouters({
    queryImpl: async text => {
      if (text.includes('FROM campaign_matches cm')) {
        return {
          rows: [
            {
              id: MATCH_UUID,
              campaign_id: CAMPAIGN_UUID,
              sponsor_user_id: 'different-sponsor-uuid',
              creator_id: 'different-creator-uuid',
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const res = await request(buildApp(campaignRouter)).patch(
    `/${CAMPAIGN_UUID}/matches/${MATCH_UUID}/complete`
  );

  assert.equal(res.status, 403);
  assert.ok(res.body.error);
});

test('PATCH /campaigns/:id/matches/:matchId/complete returns 404 when match not found', async () => {
  const { campaignRouter } = buildRouters({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(buildApp(campaignRouter)).patch(
    `/${CAMPAIGN_UUID}/matches/${MATCH_UUID}/complete`
  );

  assert.equal(res.status, 404);
});
