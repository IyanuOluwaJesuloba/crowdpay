const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { Keypair } = require('@stellar/stellar-sdk');

if (!process.env.PLATFORM_SECRET_KEY) {
  process.env.PLATFORM_SECRET_KEY = Keypair.random().secret();
}
if (!process.env.USDC_ISSUER) {
  process.env.USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
}

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const CREATOR_ID = 'creator-1';
const AUDITOR_KEY = 'GAJZF6DOHVKNA4VYDMGEB4BOBV27VI6O5ERDGJP5TH6JPGIUAUSLNCRS';
const DEST = 'GD3I6UAGVCRIWVC5SVFHIHARP7IXKBGKUL74JTCU64T5LCQKFPYAYCC5';

function buildApp({ queryImpl = async () => ({ rows: [] }), treasuryStub = {}, user } = {}) {
  const router = proxyquire('./treasury', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info() {}, warn() {}, error() {} },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = user || { userId: CREATOR_ID, role: 'user' };
        next();
      },
    },
    '../services/contractTreasury': {
      setPolicy: async () => ({}),
      getTreasuryStatus: async () => ({}),
      buildWithdrawalRequest: async () => ({}),
      approvePendingWithdrawal: async () => ({}),
      triggerAutoRefund: async () => ({}),
      reconcileWithdrawals: async () => ({}),
      ...treasuryStub,
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns/:id/treasury', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

/** A contract rejection as the service raises it. */
function contractError(code, statusCode = 422) {
  const err = new Error(`Treasury rejected the call: ${code}`);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function ownerQuery(overrides = {}) {
  return async (text) => {
    if (text.includes('SELECT creator_id FROM campaigns')) {
      return { rows: [{ creator_id: CREATOR_ID }] };
    }
    if (text.includes('auditor_public_key FROM campaigns')) {
      // `in` rather than ??, so an explicit null models "no auditor configured".
      const key = 'auditorKey' in overrides ? overrides.auditorKey : AUDITOR_KEY;
      return { rows: [{ auditor_public_key: key }] };
    }
    if (text.includes('wallet_public_key FROM users')) {
      const key = 'userKey' in overrides ? overrides.userKey : AUDITOR_KEY;
      return { rows: [{ wallet_public_key: key }] };
    }
    return { rows: [] };
  };
}

// ── policy ───────────────────────────────────────────────────────────────────

test('POST /treasury/policy stores the policy for the creator', async () => {
  let received;
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      setPolicy: async (_id, policy) => {
        received = policy;
        return { id: 'policy-1', min_hold_days: 30 };
      },
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/policy`)
    .send({ minHoldDays: 30, maxSingleWithdrawalPct: 25, autoRefundOnMiss: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'policy-1');
  assert.equal(received.minHoldDays, 30);
});

test('POST /treasury/policy is refused for a non-creator', async () => {
  const app = buildApp({
    queryImpl: ownerQuery(),
    user: { userId: 'someone-else', role: 'user' },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/policy`)
    .send({ minHoldDays: 1 });
  assert.equal(res.status, 403);
});

test('POST /treasury/policy surfaces an out-of-range policy as 400 INVALID_POLICY', async () => {
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      setPolicy: async () => {
        throw contractError('INVALID_POLICY', 400);
      },
    },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/policy`)
    .send({ maxSingleWithdrawalPct: 500 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_POLICY');
});

test('POST /treasury/policy is refused once the treasury is deployed', async () => {
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      setPolicy: async () => {
        throw contractError('TREASURY_ALREADY_DEPLOYED', 409);
      },
    },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/policy`)
    .send({ minHoldDays: 1 });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'TREASURY_ALREADY_DEPLOYED');
});

// ── status ───────────────────────────────────────────────────────────────────

test('GET /treasury/status is public and returns live contract state', async () => {
  const app = buildApp({
    treasuryStub: {
      getTreasuryStatus: async () => ({
        contractId: 'CTREASURY',
        totalReceived: '10000.0000000',
        totalWithdrawn: '2500.0000000',
        available: '7500.0000000',
        paused: false,
        policy: { minHoldDays: 30, maxSingleWithdrawalPct: 25 },
        withdrawalHistory: [],
        pendingWithdrawals: [],
      }),
    },
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/treasury/status`);
  assert.equal(res.status, 200);
  assert.equal(res.body.available, '7500.0000000');
  assert.equal(res.body.policy.maxSingleWithdrawalPct, 25);
});

test('GET /treasury/status is a 409 for a standard multisig campaign', async () => {
  const app = buildApp({
    treasuryStub: {
      getTreasuryStatus: async () => {
        throw contractError('NOT_CONTRACT_WALLET', 409);
      },
    },
  });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/treasury/status`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NOT_CONTRACT_WALLET');
});

// ── withdrawals ──────────────────────────────────────────────────────────────

test('POST /treasury/withdrawal returns immediate for a request under the threshold', async () => {
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      buildWithdrawalRequest: async () => ({
        type: 'immediate',
        pendingId: null,
        withdrawal: { id: 'w-1', status: 'completed' },
      }),
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/withdrawal`)
    .send({ amount: '100', destination: DEST, memo: 'tranche-1' });

  assert.equal(res.status, 200);
  assert.equal(res.body.type, 'immediate');
  assert.equal(res.body.pendingId, null);
});

test('POST /treasury/withdrawal returns pending_auditor above the auditor threshold', async () => {
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      buildWithdrawalRequest: async () => ({
        type: 'pending_auditor',
        pendingId: 7,
        withdrawal: { id: 'w-2', status: 'pending_auditor' },
      }),
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/withdrawal`)
    .send({ amount: '9000', destination: DEST });

  assert.equal(res.status, 200);
  assert.equal(res.body.type, 'pending_auditor');
  assert.equal(res.body.pendingId, 7);
});

test('POST /treasury/withdrawal reports a hold-period rejection as 422', async () => {
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      buildWithdrawalRequest: async () => {
        throw contractError('HOLD_PERIOD_NOT_ELAPSED');
      },
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/withdrawal`)
    .send({ amount: '100', destination: DEST });

  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'HOLD_PERIOD_NOT_ELAPSED');
});

test('POST /treasury/withdrawal reports the percentage ceiling as 422', async () => {
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      buildWithdrawalRequest: async () => {
        throw contractError('EXCEEDS_MAX_WITHDRAWAL_PCT');
      },
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/withdrawal`)
    .send({ amount: '3000', destination: DEST });

  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'EXCEEDS_MAX_WITHDRAWAL_PCT');
});

test('POST /treasury/withdrawal validates its own input before calling the contract', async () => {
  let called = false;
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      buildWithdrawalRequest: async () => {
        called = true;
        return {};
      },
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/withdrawal`)
    .send({ amount: '100' });

  assert.equal(res.status, 400);
  assert.equal(called, false, 'a malformed request must not reach the contract');
});

test('POST /treasury/withdrawal is refused for a non-creator', async () => {
  const app = buildApp({
    queryImpl: ownerQuery(),
    user: { userId: 'not-the-creator', role: 'user' },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/withdrawal`)
    .send({ amount: '100', destination: DEST });
  assert.equal(res.status, 403);
});

// ── auditor approval ─────────────────────────────────────────────────────────

test('POST /treasury/withdrawal/:pendingId/approve releases the parked withdrawal', async () => {
  let approvedId;
  let approverId;
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      approvePendingWithdrawal: async (_campaignId, pendingId, opts) => {
        approvedId = pendingId;
        approverId = opts?.approverId;
        return { id: 'w-2', status: 'completed' };
      },
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/withdrawal/7/approve`)
    .send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'completed');
  assert.equal(approvedId, 7);
  // The route must identify who is approving so the service can sign with the
  // auditor's own key rather than a shared/platform one.
  assert.equal(approverId, CREATOR_ID);
});

test('a user who is not the auditor cannot approve', async () => {
  const app = buildApp({
    // The caller's wallet differs from the campaign's recorded auditor key.
    queryImpl: ownerQuery({ userKey: DEST }),
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/withdrawal/7/approve`)
    .send({});
  assert.equal(res.status, 403);
});

test('approval is refused when the campaign has no auditor', async () => {
  const app = buildApp({ queryImpl: ownerQuery({ auditorKey: null }) });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/withdrawal/7/approve`)
    .send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'AUDITOR_NOT_CONFIGURED');
});

test('a non-numeric pending id is rejected before the contract is called', async () => {
  let called = false;
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      approvePendingWithdrawal: async () => {
        called = true;
        return {};
      },
    },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/treasury/withdrawal/abc/approve`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

// ── refunds ──────────────────────────────────────────────────────────────────

test('POST /treasury/refund records the refund batch', async () => {
  const app = buildApp({
    treasuryStub: {
      triggerAutoRefund: async () => ({
        id: 'r-1',
        total_refunded: '6000.0000000',
        contributor_count: 3,
      }),
    },
  });
  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/treasury/refund`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.total_refunded, '6000.0000000');
});

test('POST /treasury/refund reports unmet conditions as 422', async () => {
  const app = buildApp({
    treasuryStub: {
      triggerAutoRefund: async () => {
        throw contractError('REFUND_CONDITIONS_NOT_MET');
      },
    },
  });
  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/treasury/refund`).send({});
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'REFUND_CONDITIONS_NOT_MET');
});

// ── reconciliation ───────────────────────────────────────────────────────────

test('GET /treasury/reconciliation reports the on-chain and database totals', async () => {
  const app = buildApp({
    queryImpl: ownerQuery(),
    treasuryStub: {
      reconcileWithdrawals: async () => ({
        onChainCount: 50,
        databaseCount: 50,
        onChainTotal: '5000.0000000',
        databaseTotal: '5000.0000000',
        inSync: true,
      }),
    },
  });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/treasury/reconciliation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.inSync, true);
  assert.equal(res.body.onChainCount, 50);
});
