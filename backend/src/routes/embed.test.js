'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'testsecret';
process.env.JWT_SECRET = JWT_SECRET;

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const CREATOR_ID = '22222222-2222-2222-2222-222222222222';
const TOKEN_ID = '33333333-3333-3333-3333-333333333333';

function buildApp({ dbQueryImpl, authUser }) {
  const router = proxyquire('./embed', {
    '../config/database': {
      query: dbQueryImpl,
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = authUser || { userId: CREATOR_ID, role: 'creator' };
        next();
      },
    },
    '../middleware/embedAuth': {
      requireEmbedToken: (req, _res, next) => next(),
    },
    '../services/trendingService': {
      getTrendingCampaigns: async () => [],
    },
    '../utils/asyncHandler': (fn) => (req, res, next) => fn(req, res, next).catch(next),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/embed', router);
  app.use('/embed', router);
  return app;
}

test('POST /api/embed/tokens creates a signed JWT embed token for creator', async () => {
  const queryImpl = async (text, params) => {
    if (text.includes('FROM campaigns WHERE id = $1')) {
      return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Solar Project' }] };
    }
    if (text.includes('INSERT INTO embed_tokens')) {
      return {
        rows: [
          {
            id: TOKEN_ID,
            campaign_id: CAMPAIGN_ID,
            creator_id: CREATOR_ID,
            allowed_origins: params[2],
            expires_at: params[3],
            created_at: new Date().toISOString(),
          },
        ],
      };
    }
    return { rows: [] };
  };

  const app = buildApp({ dbQueryImpl: queryImpl });

  const res = await request(app)
    .post('/api/embed/tokens')
    .send({ campaignId: CAMPAIGN_ID, allowedOrigins: ['https://example.com'], expiresIn: '7d' });

  assert.equal(res.status, 201);
  assert.equal(res.body.campaignId, CAMPAIGN_ID);

  const decoded = jwt.verify(res.body.token, JWT_SECRET);
  assert.equal(decoded.sub, CAMPAIGN_ID);
  assert.deepEqual(decoded.origins, ['https://example.com']);
});

test('POST /api/embed/tokens rejects non-creator request', async () => {
  const queryImpl = async () => ({
    rows: [{ id: CAMPAIGN_ID, creator_id: 'other-creator-id', title: 'Solar Project' }],
  });

  const app = buildApp({
    dbQueryImpl: queryImpl,
    authUser: { userId: 'unauthorized-user-id', role: 'creator' },
  });

  const res = await request(app)
    .post('/api/embed/tokens')
    .send({ campaignId: CAMPAIGN_ID, allowedOrigins: ['https://example.com'] });

  assert.equal(res.status, 403);
});

test('GET /api/embed/campaigns/:id origin validation rejects unauthorized origin', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: ['https://example.com'] }, JWT_SECRET);

  const app = buildApp({ dbQueryImpl: async () => ({ rows: [] }) });

  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://other.com');

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Origin not allowed for this embed token');
});

test('GET /api/embed/campaigns/:id returns zero internal fields (schema check)', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: ['https://example.com'] }, JWT_SECRET);

  const queryImpl = async (text) => {
    if (text.includes('FROM embed_tokens')) {
      return { rows: [{ id: TOKEN_ID, campaign_id: CAMPAIGN_ID }] };
    }
    if (text.includes('FROM campaigns WHERE id = $1')) {
      return {
        rows: [
          {
            title: 'Clean Water',
            description: 'Provide clean water to villages',
            target_amount: '5000',
            raised_amount: '2500',
            asset_type: 'USDC',
            status: 'active',
            deadline: '2026-12-31',
            wallet_public_key: 'GBD...',
            wallet_secret_encrypted: 'S...',
            creator_email: 'secret@creator.com',
            id: CAMPAIGN_ID,
          },
        ],
      };
    }
    if (text.includes('FROM embed_contributions')) {
      return { rows: [{ count: 15 }] };
    }
    return { rows: [] };
  };

  const app = buildApp({ dbQueryImpl: queryImpl });

  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://example.com');

  assert.equal(res.status, 200);

  // Schema-checking: confirming zero internal fields returned
  const keys = Object.keys(res.body);
  const expectedKeys = [
    'title',
    'description',
    'goal',
    'totalRaised',
    'percentFunded',
    'deadline',
    'asset',
    'status',
    'contributorCount',
  ];

  assert.deepEqual(keys.sort(), expectedKeys.sort());
  assert.equal(res.body.wallet_public_key, undefined);
  assert.equal(res.body.wallet_secret_encrypted, undefined);
  assert.equal(res.body.creator_email, undefined);
  assert.equal(res.body.id, undefined);
});

test('POST /api/embed/campaigns/:id/contribute rate limiting returns 429 on 11th attempt per IP', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: ['https://example.com'] }, JWT_SECRET);

  const queryImpl = async (text) => {
    if (text.includes('FROM embed_tokens')) {
      return { rows: [{ id: TOKEN_ID, campaign_id: CAMPAIGN_ID }] };
    }
    if (text.includes('contributor_ip_hash')) {
      // Return 10 existing attempts to trigger 429 limit on 11th attempt
      return { rows: [{ count: 10 }] };
    }
    return { rows: [] };
  };

  const app = buildApp({ dbQueryImpl: queryImpl });

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://example.com')
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'Too Many Requests');
});

test('GET /embed/widget.html responds with frame-ancestors * CSP headers', async () => {
  const app = buildApp({ dbQueryImpl: async () => ({ rows: [] }) });

  const res = await request(app).get('/embed/widget.html');

  assert.equal(res.status, 200);
  const csp = res.headers['content-security-policy'];
  assert.ok(csp.includes('frame-ancestors *'));
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes('connect-src'));
});

// ── Contribution validation regression tests (issue #729) ──────────────────

function buildContributeQueryImpl({
  status = 'active',
  deadline = null,
  minContribution = null,
  maxContribution = null,
  ipCount = 0,
  tokenCount = 0,
  existingContribTotal = '0',
} = {}) {
  return async (text) => {
    if (text.includes('FROM embed_tokens')) {
      return { rows: [{ id: TOKEN_ID, campaign_id: CAMPAIGN_ID }] };
    }
    if (text.includes('contributor_ip_hash') && text.includes('COUNT')) {
      return { rows: [{ count: ipCount }] };
    }
    if (text.includes('embed_token_id') && text.includes('COUNT')) {
      return { rows: [{ count: tokenCount }] };
    }
    if (text.includes('FROM campaigns') && text.includes('deleted_at IS NULL') && !text.includes('UPDATE')) {
      return {
        rows: [
          {
            id: CAMPAIGN_ID,
            status,
            deadline,
            target_amount: '10000',
            raised_amount: '2500',
            min_contribution: minContribution,
            max_contribution: maxContribution,
            creator_id: CREATOR_ID,
          },
        ],
      };
    }
    if (text.includes('SUM(amount)')) {
      return { rows: [{ total: existingContribTotal }] };
    }
    if (text.includes('UPDATE campaigns')) {
      return { rows: [{ raised_amount: '2550', target_amount: '10000' }] };
    }
    if (text.includes('INSERT INTO embed_contributions')) {
      return { rows: [] };
    }
    return { rows: [] };
  };
}

test('POST contribute rejects contributions to a failed campaign', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const app = buildApp({
    dbQueryImpl: buildContributeQueryImpl({ status: 'failed' }),
  });

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Campaign is not accepting contributions');
});

test('POST contribute rejects contributions to a cancelled campaign', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const app = buildApp({
    dbQueryImpl: buildContributeQueryImpl({ status: 'cancelled' }),
  });

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Campaign is not accepting contributions');
});

test('POST contribute rejects contributions after the campaign deadline', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const pastDeadline = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const app = buildApp({
    dbQueryImpl: buildContributeQueryImpl({ deadline: pastDeadline }),
  });

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Campaign deadline has passed');
});

test('POST contribute rejects amounts below campaign minimum', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const app = buildApp({
    dbQueryImpl: buildContributeQueryImpl({ minContribution: '25' }),
  });

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 10, asset: 'USDC' });

  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('below the minimum'));
});

test('POST contribute rejects amounts above campaign maximum', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const app = buildApp({
    dbQueryImpl: buildContributeQueryImpl({ maxContribution: '100' }),
  });

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 500, asset: 'USDC' });

  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('exceeds the maximum'));
});

test('POST contribute rejects contribution that would exceed per-contributor cap', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  // max is 100, contributor has already contributed 80 — a further 50 exceeds it.
  const app = buildApp({
    dbQueryImpl: buildContributeQueryImpl({
      maxContribution: '100',
      existingContribTotal: '80',
    }),
  });

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('per-contributor limit'));
});

test('POST contribute accepts valid contribution to active campaign with all checks passing', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const futureDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const app = buildApp({
    dbQueryImpl: buildContributeQueryImpl({
      status: 'active',
      deadline: futureDeadline,
      minContribution: '5',
      maxContribution: '500',
      existingContribTotal: '0',
    }),
  });

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.amount, 50);
  assert.ok(res.body.txHash);
});
