const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { requireOpsApiKey } = require('./ops');

function createMockApp() {
  const app = express();
  app.use(express.json());
  app.use(requireOpsApiKey);
  app.get('/test', (_req, res) => res.json({ ok: true }));
  return app;
}

test('requireOpsApiKey returns 401 when header is missing', async () => {
  process.env.OPS_API_KEY = 'test_ops_key_123';
  const req = {
    headers: {},
    path: '/api/ops/health',
    ip: '127.0.0.1',
  };
  let statusCode = 200;
  let responseData = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      responseData = data;
      return this;
    },
  };
  let nextCalled = false;

  requireOpsApiKey(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
  assert.equal(responseData.error.code, 'UNAUTHORIZED_OPS');
});

test('requireOpsApiKey passes when valid OPS_API_KEY is provided in headers', async () => {
  process.env.OPS_API_KEY = 'test_ops_key_123';
  const req = {
    headers: { 'ops_api_key': 'test_ops_key_123' },
    path: '/api/ops/health',
    ip: '127.0.0.1',
  };
  let nextCalled = false;
  const res = {
    status() { return this; },
    json() { return this; },
  };

  requireOpsApiKey(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test('requireOpsApiKey passes with x-ops-api-key header', async () => {
  process.env.OPS_API_KEY = 'test_ops_key_123';
  const req = {
    headers: { 'x-ops-api-key': 'test_ops_key_123' },
    path: '/api/ops/health',
    ip: '127.0.0.1',
  };
  let nextCalled = false;
  const res = {
    status() { return this; },
    json() { return this; },
  };

  requireOpsApiKey(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});
