'use strict';

/**
 * Tests for the embed origins management API (#1063).
 *
 * GET  /api/campaigns/:id/embed/origins  — list approved origins
 * PUT  /api/campaigns/:id/embed/origins  — replace the full list (owner only)
 *
 * Covers:
 *   - Owner-only access (403 for non-owners)
 *   - 404 for missing campaigns
 *   - GET returns the stored list
 *   - PUT normalises and deduplicates on the way in
 *   - PUT rejects malformed, over-limit, and non-string inputs
 *   - PUT with [] clears the list
 *   - Wildcard "*" is accepted as a valid entry
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildRouter(queryImpl, userId = OWNER_ID) {
  return proxyquire('./embedOrigins', {
    '../config/database': { query: queryImpl },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId };
        next();
      },
    },
    '../utils/asyncHandler': fn => (req, res, next) => fn(req, res, next).catch(next),
  });
}

function buildApp(queryImpl, userId = OWNER_ID) {
  const router = buildRouter(queryImpl, userId);
  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

function campaignQueryImpl({
  creatorId = OWNER_ID,
  found = true,
  existingOrigins = [],
} = {}) {
  return async (sql, params) => {
    if (sql.includes('FROM campaigns') && sql.includes('creator_id')) {
      if (!found) return { rows: [] };
      return { rows: [{ creator_id: creatorId }] };
    }
    if (sql.includes('FROM campaign_embed_allowed_origins') && sql.includes('SELECT origin')) {
      return { rows: existingOrigins.map(o => ({ origin: o })) };
    }
    if (sql.includes('DELETE FROM campaign_embed_allowed_origins')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO campaign_embed_allowed_origins')) {
      return { rows: [] };
    }
    return { rows: [] };
  };
}

// ─── GET ─────────────────────────────────────────────────────────────────────

test('GET /embed/origins returns 404 for a missing campaign', async () => {
  const app = buildApp(campaignQueryImpl({ found: false }));
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`);
  assert.equal(res.status, 404);
});

test('GET /embed/origins returns 403 for a non-owner', async () => {
  const app = buildApp(campaignQueryImpl({ creatorId: OWNER_ID }), OTHER_USER_ID);
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`);
  assert.equal(res.status, 403);
  assert.ok(res.body.error.includes('campaign owner'));
});

test('GET /embed/origins returns empty array when no origins are configured', async () => {
  const app = buildApp(campaignQueryImpl({ existingOrigins: [] }));
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { origins: [] });
});

test('GET /embed/origins returns the stored origin list', async () => {
  const origins = ['https://app.example.com', 'https://www.example.com'];
  const app = buildApp(campaignQueryImpl({ existingOrigins: origins }));
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.origins, origins);
});

// ─── PUT ─────────────────────────────────────────────────────────────────────

test('PUT /embed/origins returns 404 for a missing campaign', async () => {
  const app = buildApp(campaignQueryImpl({ found: false }));
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: ['https://example.com'] });
  assert.equal(res.status, 404);
});

test('PUT /embed/origins returns 403 for a non-owner', async () => {
  const app = buildApp(campaignQueryImpl(), OTHER_USER_ID);
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: ['https://example.com'] });
  assert.equal(res.status, 403);
});

test('PUT /embed/origins replaces the list with a valid single entry', async () => {
  const inserted = [];
  const queryImpl = async (sql, params) => {
    if (sql.includes('FROM campaigns') && sql.includes('creator_id')) {
      return { rows: [{ creator_id: OWNER_ID }] };
    }
    if (sql.includes('INSERT INTO campaign_embed_allowed_origins')) {
      inserted.push(...params.slice(1));
      return { rows: [] };
    }
    return { rows: [] };
  };
  const app = buildApp(queryImpl);
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: ['https://app.example.com'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.origins, ['https://app.example.com']);
  assert.ok(inserted.includes('https://app.example.com'));
});

test('PUT /embed/origins normalises origins before storing', async () => {
  const inserted = [];
  const queryImpl = async (sql, params) => {
    if (sql.includes('FROM campaigns') && sql.includes('creator_id')) {
      return { rows: [{ creator_id: OWNER_ID }] };
    }
    if (sql.includes('INSERT INTO campaign_embed_allowed_origins')) {
      // params = [campaignId, origin1, origin2, ...]
      inserted.push(...params.slice(1));
      return { rows: [] };
    }
    return { rows: [] };
  };
  const app = buildApp(queryImpl);
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: ['HTTPS://APP.EXAMPLE.COM:443/'] }); // uppercase, default port, trailing slash
  assert.equal(res.status, 200);
  // Should be normalised to lowercase, port stripped, slash stripped
  assert.deepEqual(res.body.origins, ['https://app.example.com']);
  assert.ok(inserted.includes('https://app.example.com'));
});

test('PUT /embed/origins deduplicates equivalent origins', async () => {
  const app = buildApp(campaignQueryImpl());
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: ['https://example.com', 'https://example.com:443', 'https://EXAMPLE.COM/'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.origins.length, 1);
  assert.equal(res.body.origins[0], 'https://example.com');
});

test('PUT /embed/origins accepts the wildcard entry "*"', async () => {
  const app = buildApp(campaignQueryImpl());
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: ['*'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.origins, ['*']);
});

test('PUT /embed/origins clears the list when sent an empty array', async () => {
  const deleted = [];
  const queryImpl = async (sql, params) => {
    if (sql.includes('FROM campaigns') && sql.includes('creator_id')) {
      return { rows: [{ creator_id: OWNER_ID }] };
    }
    if (sql.includes('DELETE FROM campaign_embed_allowed_origins')) {
      deleted.push(params[0]);
      return { rows: [] };
    }
    return { rows: [] };
  };
  const app = buildApp(queryImpl);
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: [] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.origins, []);
  assert.ok(deleted.includes(CAMPAIGN_ID));
});

test('PUT /embed/origins returns 400 when origins is not an array', async () => {
  const app = buildApp(campaignQueryImpl());
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: 'https://example.com' }); // string, not array
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('"origins" must be an array'));
});

test('PUT /embed/origins returns 400 for a non-string entry', async () => {
  const app = buildApp(campaignQueryImpl());
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: [42] });
  assert.equal(res.status, 400);
});

test('PUT /embed/origins returns 400 for a malformed origin', async () => {
  const app = buildApp(campaignQueryImpl());
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: ['not-a-url'] });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('not a valid origin'));
});

test('PUT /embed/origins returns 400 for an origin with a path', async () => {
  const app = buildApp(campaignQueryImpl());
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: ['https://example.com/some/path'] });
  assert.equal(res.status, 400);
});

test('PUT /embed/origins returns 400 when over the 10-entry limit', async () => {
  const app = buildApp(campaignQueryImpl());
  const tooMany = Array.from({ length: 11 }, (_, i) => `https://site${i}.example.com`);
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: tooMany });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('10'));
});

test('PUT /embed/origins returns 400 for a non-loopback IP origin', async () => {
  const app = buildApp(campaignQueryImpl());
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: ['http://192.168.1.10'] });
  assert.equal(res.status, 400);
});

test('PUT /embed/origins accepts localhost as a valid origin', async () => {
  const app = buildApp(campaignQueryImpl());
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/embed/origins`)
    .send({ origins: ['http://localhost:3000'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.origins, ['http://localhost:3000']);
});
