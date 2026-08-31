const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ pipelineResults = [[null, 1], [null, 1], [null, 1], [null, 1]] } = {}) {
  const redisStub = {
    pipeline: () => ({
      incr: () => {},
      expire: () => {},
      exec: async () => pipelineResults,
    }),
  };

  const { contributionRateLimiter } = proxyquire('./contributionRateLimiter', {
    '../config/redis': redisStub,
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {} },
  });

  const app = express();
  app.use(express.json());
  app.post('/api/contributions', contributionRateLimiter, (req, res) => {
    res.status(200).json({ success: true });
  });
  return app;
}

test('contributionRateLimiter allows requests within limits', async () => {
  const app = buildApp({
    pipelineResults: [[null, 2], [null, 1], [null, 2], [null, 1]],
  });

  const res = await request(app)
    .post('/api/contributions')
    .send({ wallet_public_key: 'GWALLET' });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('contributionRateLimiter returns 429 with Retry-After header when IP limit exceeded', async () => {
  const app = buildApp({
    pipelineResults: [[null, 11], [null, 1], [null, 2], [null, 1]],
  });

  const res = await request(app)
    .post('/api/contributions')
    .send({ wallet_public_key: 'GWALLET' });

  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '60');
  assert.equal(res.body.error, 'Too Many Requests');
});

test('contributionRateLimiter returns 429 when wallet limit exceeded', async () => {
  const app = buildApp({
    pipelineResults: [[null, 2], [null, 1], [null, 6], [null, 1]],
  });

  const res = await request(app)
    .post('/api/contributions')
    .send({ wallet_public_key: 'GWALLET' });

  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '60');
});

test('contributionRateLimiter bypasses for configured test accounts', async () => {
  process.env.RATE_LIMIT_BYPASS_ACCOUNTS = 'GBYPASSWALLET';
  const app = buildApp({
    pipelineResults: [[null, 20], [null, 1], [null, 20], [null, 1]],
  });

  const res = await request(app)
    .post('/api/contributions')
    .send({ wallet_public_key: 'GBYPASSWALLET' });

  assert.equal(res.status, 200);
  delete process.env.RATE_LIMIT_BYPASS_ACCOUNTS;
});
