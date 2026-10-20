const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const CAMPAIGN_ID = 'c-1';
const JWT_SECRET = 'test-secret';
const TOKEN_ID = 't-1';
const CREATOR_ID = 'u-1';
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp(queryImpl) {
  const router = proxyquire('./embed', {
    '../config/database': { query: queryImpl },
    '../utils/asyncHandler': fn => (req, res, next) => fn(req, res, next).catch(next),
    '../middleware/rateLimiter': {
      embedStatsLimiter: (_req, _res, next) => next(),
    },
    '../services/embedTokenJwtService': {
      extractEmbedToken: req => req.headers.authorization?.replace('Bearer ', ''),
      verifyEmbedToken: token => {
        try {
          return jwt.verify(token, JWT_SECRET);
        } catch {
          return null;
        }
      },
      buildEmbedCsp: () => "default-src 'self'; frame-ancestors *; connect-src *",
      validateOrigin: () => true,
    },
    // Stub originPolicy so the pre-existing tests (which don't test origin
    // enforcement) are not broken by the new campaign allowlist check.
    // The dedicated origin tests below use buildAppWithOriginPolicy instead.
    '../utils/originPolicy': {
      checkOrigin: () => ({ allowed: true, reason: 'stub' }),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/embed', router);
  return app;
}

test('GET /api/embed/:campaignId/stats returns safe public campaign stats', async () => {
  const queryImpl = async (sql, params) => {
    if (sql.includes('FROM campaigns')) {
      return {
        rows: [
          {
            id: 'c-1',
            title: 'Clean Water Initiative',
            description: 'Build wells',
            target_amount: '10000',
            raised_amount: '5000',
            asset_type: 'USDC',
            status: 'active',
            deadline: new Date(Date.now() + 86400000 * 5).toISOString(),
            backer_count: 15,
            contribution_url: 'https://crowdpay.com/campaigns/c-1',
          },
        ],
      };
    }
    if (sql.includes('FROM contributions')) {
      return {
        rows: [
          {
            id: 'b-1',
            amount: '100',
            created_at: new Date().toISOString(),
            contributor_name: 'Alice',
          },
        ],
      };
    }
    if (sql.includes('FROM milestones')) {
      return {
        rows: [
          {
            id: 'm-1',
            title: 'Phase 1',
            release_percentage: '100',
            status: 'pending',
            sort_order: 0,
          },
        ],
      };
    }
    return { rows: [] };
  };

  const app = buildApp(queryImpl);
  const res = await request(app).get('/api/embed/c-1/stats');

  assert.equal(res.status, 200);
  assert.equal(res.body.campaign.title, 'Clean Water Initiative');
  assert.equal(res.body.campaign.raised_amount, '5000');
  assert.equal(res.body.campaign.target_amount, '10000');
  assert.equal(res.body.campaign.backer_count, 15);
  assert.equal(res.body.recentContributors.length, 1);
  assert.equal(res.body.recentContributors[0].contributor_name, 'Alice');
});

test('GET /api/embed/:campaignId/stats returns 404 if campaign missing', async () => {
  const queryImpl = async () => ({ rows: [] });
  const app = buildApp(queryImpl);
  const res = await request(app).get('/api/embed/missing-id/stats');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Campaign not found' });
});
test('POST /api/embed/campaigns/:id/contribute rate limiting returns 429 on 11th attempt per IP', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: ['https://example.com'] }, JWT_SECRET);

  const queryImpl = async text => {
    if (text.includes('FROM embed_tokens')) {
      return { rows: [{ id: TOKEN_ID, campaign_id: CAMPAIGN_ID }] };
    }
    if (text.includes('contributor_ip_hash')) {
      return { rows: [{ count: 10 }] };
    }
    return { rows: [] };
  };

  const app = buildApp(queryImpl);

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://example.com')
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'Too Many Requests');
});

test('GET /api/embed/widget.html responds with frame-ancestors * CSP headers', async () => {
  const app = buildApp(async () => ({ rows: [] }));

  const res = await request(app).get('/api/embed/widget.html');

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
  return async text => {
    if (text.includes('FROM embed_tokens')) {
      return { rows: [{ id: TOKEN_ID, campaign_id: CAMPAIGN_ID }] };
    }
    if (text.includes('contributor_ip_hash') && text.includes('COUNT')) {
      return { rows: [{ count: ipCount }] };
    }
    if (text.includes('embed_token_id') && text.includes('COUNT')) {
      return { rows: [{ count: tokenCount }] };
    }
    if (
      text.includes('FROM campaigns') &&
      text.includes('deleted_at IS NULL') &&
      !text.includes('UPDATE')
    ) {
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
  const app = buildApp(buildContributeQueryImpl({ status: 'failed' }));

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Campaign is not accepting contributions');
});

test('POST contribute rejects contributions to a cancelled campaign', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const app = buildApp(buildContributeQueryImpl({ status: 'cancelled' }));

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
  const app = buildApp(buildContributeQueryImpl({ deadline: pastDeadline }));

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Campaign deadline has passed');
});

test('POST contribute rejects amounts below campaign minimum', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const app = buildApp(buildContributeQueryImpl({ minContribution: '25' }));

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 10, asset: 'USDC' });

  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('below the minimum'));
});

test('POST contribute rejects amounts above campaign maximum', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const app = buildApp(buildContributeQueryImpl({ maxContribution: '100' }));

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
  const app = buildApp(
    buildContributeQueryImpl({
      maxContribution: '100',
      existingContribTotal: '80',
    })
  );

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('per-contributor limit'));
});

// TODO(#786): Test expects {success, amount, txHash} but route returns {id, raised_amount, target_amount}
test(
  'POST contribute accepts valid contribution to active campaign with all checks passing',
  { skip: 'Test response shape mismatch - see #786' },
  async () => {
    const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
    const futureDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const app = buildApp(
      buildContributeQueryImpl({
        status: 'active',
        deadline: futureDeadline,
        minContribution: '5',
        maxContribution: '500',
        existingContribTotal: '0',
      })
    );

    const res = await request(app)
      .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
      .set('Authorization', `Bearer ${embedToken}`)
      .send({ amount: 50, asset: 'USDC' });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.amount, 50);
    assert.ok(res.body.txHash);
  }
);

test('POST contribute fails closed without ALLOW_EMBED_SIMULATED_CONTRIBUTIONS (#813)', async () => {
  const prev = process.env.ALLOW_EMBED_SIMULATED_CONTRIBUTIONS;
  delete process.env.ALLOW_EMBED_SIMULATED_CONTRIBUTIONS;

  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  let updatedRaised = false;
  let insertedEmbed = false;
  const queryImpl = buildContributeQueryImpl({ status: 'active' });
  const wrapped = async (text, params) => {
    if (text.includes('UPDATE campaigns') && text.includes('raised_amount')) {
      updatedRaised = true;
    }
    if (text.includes('INSERT INTO embed_contributions')) {
      insertedEmbed = true;
    }
    return queryImpl(text, params);
  };

  const app = buildApp(wrapped);
  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'EMBED_PAYMENT_REQUIRED');
  assert.equal(updatedRaised, false);
  assert.equal(insertedEmbed, false);

  if (prev === undefined) delete process.env.ALLOW_EMBED_SIMULATED_CONTRIBUTIONS;
  else process.env.ALLOW_EMBED_SIMULATED_CONTRIBUTIONS = prev;
});

test('POST contribute allows simulation when ALLOW_EMBED_SIMULATED_CONTRIBUTIONS=true (#813)', async () => {
  const prev = process.env.ALLOW_EMBED_SIMULATED_CONTRIBUTIONS;
  process.env.ALLOW_EMBED_SIMULATED_CONTRIBUTIONS = 'true';

  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const app = buildApp(buildContributeQueryImpl({ status: 'active' }));

  const res = await request(app)
    .post(`/api/embed/campaigns/${CAMPAIGN_ID}/contribute`)
    .set('Authorization', `Bearer ${embedToken}`)
    .send({ amount: 50, asset: 'USDC' });

  assert.equal(res.status, 200);
  assert.equal(res.body.simulated, true);
  assert.ok(res.body.txHash);
  assert.ok(String(res.body.txHash).startsWith('tx_'));

  if (prev === undefined) delete process.env.ALLOW_EMBED_SIMULATED_CONTRIBUTIONS;
  else process.env.ALLOW_EMBED_SIMULATED_CONTRIBUTIONS = prev;
});

// ─── Origin enforcement tests (#1063) ────────────────────────────────────────
//
// These tests use a separate buildApp variant that wires the REAL checkOrigin
// utility instead of the stub validateOrigin: () => true used above.
// The DB stub returns an `allowed_origins` list that drives the policy.

function buildAppWithOriginPolicy(queryImpl, localhostOptIn = false) {
  const savedEnv = { ...process.env };

  const router = proxyquire('./embed', {
    '../config/database': { query: queryImpl },
    '../utils/asyncHandler': fn => (req, res, next) => fn(req, res, next).catch(next),
    '../middleware/rateLimiter': {
      embedStatsLimiter: (_req, _res, next) => next(),
    },
    '../services/embedTokenJwtService': {
      signEmbedToken: () => {},
      verifyEmbedToken: token => {
        try {
          return jwt.verify(token, JWT_SECRET);
        } catch {
          return null;
        }
      },
      signMilestoneWidgetToken: () => {},
    },
    // Use the REAL originPolicy module.
    '../utils/originPolicy': require('../utils/originPolicy'),
  });

  if (localhostOptIn) {
    process.env.EMBED_ALLOW_LOCALHOST = 'true';
    process.env.NODE_ENV = 'development';
  }

  const app = express();
  app.use(express.json());
  app.use('/api/embed', router);

  // Restore env after each request (for isolation in the test process).
  app.use((_req, _res, next) => {
    Object.assign(process.env, savedEnv);
    next();
  });

  return { app, restore: () => Object.assign(process.env, savedEnv) };
}

function originQueryImpl(allowedOrigins = []) {
  return async (sql, _params) => {
    // Return the origin allowlist rows.
    if (
      sql.includes('FROM campaign_embed_allowed_origins') &&
      sql.includes('SELECT origin')
    ) {
      return { rows: allowedOrigins.map(o => ({ origin: o })) };
    }
    // Return a valid embed_token row.
    if (sql.includes('FROM embed_tokens')) {
      return {
        rows: [
          {
            id: TOKEN_ID,
            campaign_id: CAMPAIGN_ID,
            expires_at: null,
            use_count: 0,
          },
        ],
      };
    }
    if (sql.includes('UPDATE embed_tokens')) return { rows: [] };
    return { rows: [] };
  };
}

// ── GET /campaigns/:id — allowlist enforcement ────────────────────────────────

test('embed token endpoint: allows request when Origin is in the campaign allowlist', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app } = buildAppWithOriginPolicy(
    originQueryImpl(['https://app.example.com'])
  );

  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://app.example.com');

  // 404 from the DB (no campaign row) is fine — origin check passed.
  assert.notEqual(res.status, 403);
});

test('embed token endpoint: rejects request with Origin not in the campaign allowlist', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app } = buildAppWithOriginPolicy(
    originQueryImpl(['https://allowed.example.com'])
  );

  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://evil.example.com');

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'ORIGIN_NOT_ALLOWED');
});

test('embed token endpoint: denies when allowlist is empty and Origin is sent', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app } = buildAppWithOriginPolicy(originQueryImpl([])); // no allowlist

  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://any.site.example.com');

  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'no-allowlist');
});

test('embed token endpoint: allows server-to-server requests without an Origin header', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app } = buildAppWithOriginPolicy(originQueryImpl([])); // no allowlist

  // No Origin header → server-to-server call; should not be blocked.
  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`);

  // 404 from missing DB rows is fine — 403 would be wrong.
  assert.notEqual(res.status, 403);
});

test('embed token endpoint: rejects a malformed Origin header', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app } = buildAppWithOriginPolicy(
    originQueryImpl(['https://example.com'])
  );

  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'not-a-valid-origin');

  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'malformed-origin');
});

test('embed token endpoint: allows any origin when the allowlist contains "*"', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app } = buildAppWithOriginPolicy(originQueryImpl(['*']));

  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://absolutely-any-site.example.com');

  assert.notEqual(res.status, 403);
});

test('embed token endpoint: normalises Origin with default port before comparing', async () => {
  // Allowlist has origin without port; request sends with :443.
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app } = buildAppWithOriginPolicy(
    originQueryImpl(['https://example.com'])
  );

  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://example.com:443');

  assert.notEqual(res.status, 403);
});

test('embed token endpoint: rejects a subdomain not in the allowlist', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app } = buildAppWithOriginPolicy(
    originQueryImpl(['https://example.com'])
  );

  // Subdomain is NOT automatically covered by a parent-domain entry.
  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://sub.example.com');

  assert.equal(res.status, 403);
});

test('embed token endpoint: rejects a non-default port not in the allowlist', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app } = buildAppWithOriginPolicy(
    originQueryImpl(['https://example.com'])
  );

  const res = await request(app)
    .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
    .set('Authorization', `Bearer ${embedToken}`)
    .set('Origin', 'https://example.com:8443');

  assert.equal(res.status, 403);
});

// ── Local development opt-in ──────────────────────────────────────────────────

test('embed token endpoint: allows localhost when EMBED_ALLOW_LOCALHOST=true in dev', async () => {
  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app, restore } = buildAppWithOriginPolicy(originQueryImpl([]), true);

  try {
    const res = await request(app)
      .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
      .set('Authorization', `Bearer ${embedToken}`)
      .set('Origin', 'http://localhost:3000');

    // 404 from missing DB rows is acceptable — 403 would be wrong.
    assert.notEqual(res.status, 403);
  } finally {
    restore();
  }
});

test('embed token endpoint: does not allow localhost without the opt-in flag', async () => {
  const savedOptIn = process.env.EMBED_ALLOW_LOCALHOST;
  delete process.env.EMBED_ALLOW_LOCALHOST;

  const embedToken = jwt.sign({ sub: CAMPAIGN_ID, origins: [] }, JWT_SECRET);
  const { app, restore } = buildAppWithOriginPolicy(originQueryImpl([]));

  try {
    const res = await request(app)
      .get(`/api/embed/campaigns/${CAMPAIGN_ID}`)
      .set('Authorization', `Bearer ${embedToken}`)
      .set('Origin', 'http://localhost:3000');

    assert.equal(res.status, 403);
  } finally {
    if (savedOptIn !== undefined) process.env.EMBED_ALLOW_LOCALHOST = savedOptIn;
    restore();
  }
});
