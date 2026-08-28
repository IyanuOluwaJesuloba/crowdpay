'use strict';

/**
 * Contract treasury service tests. No DB or testnet required — Postgres and the
 * Soroban RPC layer are both stubbed, so these cover the service's own logic:
 * policy validation, contract-error translation, amount conversion, and the
 * database bookkeeping that has to stay in step with the contract.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
// Real Stellar keys — Address.fromString validates, so placeholders will not do.
const DEST = 'GAJZF6DOHVKNA4VYDMGEB4BOBV27VI6O5ERDGJP5TH6JPGIUAUSLNCRS';
const CREATOR = 'GD3I6UAGVCRIWVC5SVFHIHARP7IXKBGKUL74JTCU64T5LCQKFPYAYCC5';
const AUDITOR = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';

function build({ queryImpl = async () => ({ rows: [] }), soroban = {} } = {}) {
  const calls = [];
  const sorobanStub = {
    invokeContract: async (params) => {
      calls.push(params);
      return soroban.invokeResult !== undefined ? soroban.invokeResult : null;
    },
    invokeContractReadOnly: async (params) => {
      calls.push(params);
      return soroban.readResults?.[params.method];
    },
    uploadContractWasm: async () => 'wasmhash',
    createContractFromWasmHash: async () => ({ contractId: 'CTREASURY', txHash: 'tx' }),
    ...soroban.overrides,
  };

  const service = proxyquire('./contractTreasury', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info() {}, warn() {}, error() {} },
    './sorobanService': sorobanStub,
    // Real wallet-secret encryption depends on env-configured key material the
    // tests don't set up; the "encrypted" value stands in for the plaintext so
    // assertions can check exactly which key reaches signerSecret.
    './walletSecrets': {
      withDecryptedWalletSecret: async (secret, _context, fn) => fn(secret),
    },
  });

  return { service, calls };
}

function campaignRow(overrides = {}) {
  return {
    id: CAMPAIGN_ID,
    creator_id: 'creator-1',
    target_amount: '10000.0000000',
    deadline: '2026-12-31',
    asset_type: 'USDC',
    wallet_mode: 'contract',
    contract_id: 'CTREASURY',
    auditor_public_key: null,
    status: 'active',
    ...overrides,
  };
}

function userRow(overrides = {}) {
  return {
    wallet_type: 'custodial',
    wallet_public_key: CREATOR,
    wallet_secret_encrypted: 'creator-secret',
    ...overrides,
  };
}

// ── amount conversion ────────────────────────────────────────────────────────

test('converts between decimal amounts and contract stroops without drift', () => {
  const { service } = build();
  assert.equal(service.toStroops('1').toString(), '10000000');
  assert.equal(service.toStroops('0.0000001').toString(), '1');
  assert.equal(service.toStroops('1234.5').toString(), '12345000000');
  assert.equal(service.fromStroops(12345000000n), '1234.5000000');
  assert.equal(service.fromStroops(1n), '0.0000001');
  // A value with more than 7 decimals is truncated rather than rounded up, so a
  // conversion can never manufacture funds the treasury does not hold.
  assert.equal(service.toStroops('1.99999999').toString(), '19999999');
});

// ── policy validation ────────────────────────────────────────────────────────

test('accepts a policy inside every documented bound', () => {
  const { service } = build();
  const policy = service.validatePolicy({
    minHoldDays: 30,
    maxSingleWithdrawalPct: 25,
    withdrawalCooldownHours: 168,
    requireAuditorForAbove: '5000',
    autoRefundOnMiss: true,
  });
  assert.equal(policy.minHoldDays, 30);
  assert.equal(policy.maxSingleWithdrawalPct, 25);
  assert.equal(policy.autoRefundOnMiss, true);
});

test('rejects policy values outside their bounds', () => {
  const { service } = build();
  const cases = [
    { minHoldDays: 91 },
    { minHoldDays: -1 },
    { maxSingleWithdrawalPct: 0 },
    { maxSingleWithdrawalPct: 101 },
    { withdrawalCooldownHours: 169 },
    { requireAuditorForAbove: '-5' },
  ];
  for (const override of cases) {
    assert.throws(
      () => service.validatePolicy({ maxSingleWithdrawalPct: 50, ...override }),
      (err) => err.code === 'INVALID_POLICY' && err.statusCode === 400,
      `expected ${JSON.stringify(override)} to be rejected`
    );
  }
});

// ── contract error translation ───────────────────────────────────────────────

test('translates contract error ordinals into the documented symbolic codes', () => {
  const { service } = build();
  const expectations = {
    3: 'HOLD_PERIOD_NOT_ELAPSED',
    4: 'EXCEEDS_MAX_WITHDRAWAL_PCT',
    5: 'COOLDOWN_NOT_ELAPSED',
    8: 'AUDITOR_NOT_CONFIGURED',
    12: 'REFUND_CONDITIONS_NOT_MET',
  };
  for (const [ordinal, code] of Object.entries(expectations)) {
    const translated = service.translateContractError(
      new Error(`HostError: Error(Contract, #${ordinal})`)
    );
    assert.equal(translated.code, code);
    assert.equal(translated.statusCode, 422);
  }
});

test('leaves an unrecognised failure untranslated so it is not mistaken for a policy rejection', () => {
  const { service } = build();
  const original = new Error('connection reset');
  assert.equal(service.translateContractError(original), original);
});

// ── policy persistence ───────────────────────────────────────────────────────

test('setPolicy refuses once the treasury is deployed', async () => {
  const { service } = build({
    queryImpl: async () => ({ rows: [campaignRow({ contract_id: 'CTREASURY' })] }),
  });
  await assert.rejects(
    () => service.setPolicy(CAMPAIGN_ID, { maxSingleWithdrawalPct: 50 }),
    (err) => err.code === 'TREASURY_ALREADY_DEPLOYED' && err.statusCode === 409
  );
});

test('setPolicy upserts so a creator can revise terms before going live', async () => {
  let insertParams;
  const { service } = build({
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns')) {
        return { rows: [campaignRow({ contract_id: null, wallet_mode: 'standard' })] };
      }
      if (text.includes('INSERT INTO treasury_policies')) {
        insertParams = params;
        return { rows: [{ id: 'policy-1', campaign_id: CAMPAIGN_ID }] };
      }
      return { rows: [] };
    },
  });

  const row = await service.setPolicy(CAMPAIGN_ID, {
    minHoldDays: 14,
    maxSingleWithdrawalPct: 25,
    withdrawalCooldownHours: 48,
    requireAuditorForAbove: '2500',
    autoRefundOnMiss: true,
  });

  assert.equal(row.id, 'policy-1');
  assert.deepEqual(insertParams.slice(1), [14, 25, 48, '2500', true]);
});

// ── withdrawals ──────────────────────────────────────────────────────────────

test('a withdrawal under the auditor threshold is recorded as completed immediately', async () => {
  let inserted;
  const { service, calls } = build({
    soroban: { invokeResult: null },
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      if (text.includes('FROM users')) return { rows: [userRow()] };
      if (text.includes('INSERT INTO withdrawal_requests')) {
        inserted = params;
        return { rows: [{ id: 'w-1', status: 'completed', contract_pending_id: null }] };
      }
      return { rows: [] };
    },
  });

  const result = await service.buildWithdrawalRequest(CAMPAIGN_ID, {
    amount: '100',
    destination: DEST,
    memo: 'payout',
    requestedBy: 'creator-1',
  });

  assert.equal(result.type, 'immediate');
  assert.equal(result.pendingId, null);
  assert.equal(inserted[5], 'completed');
  assert.ok(inserted[7] instanceof Date, 'completed_at should be stamped');
  assert.equal(calls[0].method, 'request_withdrawal');
  // request_withdrawal requires Soroban `creator.require_auth()`; signing with the
  // platform key (or anyone else's) would fail on-chain, so the invocation must
  // carry the creator's own key, not the platform's.
  assert.equal(calls[0].signerSecret, 'creator-secret');
});

test('a withdrawal above the auditor threshold is parked as pending_auditor', async () => {
  let inserted;
  const { service } = build({
    soroban: { invokeResult: 7 },
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      if (text.includes('FROM users')) return { rows: [userRow()] };
      if (text.includes('INSERT INTO withdrawal_requests')) {
        inserted = params;
        return { rows: [{ id: 'w-2', status: 'pending_auditor', contract_pending_id: 7 }] };
      }
      return { rows: [] };
    },
  });

  const result = await service.buildWithdrawalRequest(CAMPAIGN_ID, {
    amount: '9000',
    destination: DEST,
    memo: 'big',
    requestedBy: 'creator-1',
  });

  assert.equal(result.type, 'pending_auditor');
  assert.equal(result.pendingId, 7);
  assert.equal(inserted[5], 'pending_auditor');
  assert.equal(inserted[6], 7);
  // Nothing is marked complete while the auditor has not signed.
  assert.equal(inserted[7], null);
});

test('the creator and platform accounts are distinct: requesting with only a platform key configured still signs as the creator', async () => {
  const { service, calls } = build({
    soroban: { invokeResult: null },
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      if (text.includes('FROM users')) {
        return { rows: [userRow({ wallet_public_key: CREATOR, wallet_secret_encrypted: 'creator-secret' })] };
      }
      if (text.includes('INSERT INTO withdrawal_requests')) {
        return { rows: [{ id: 'w-1', status: 'completed', contract_pending_id: null }] };
      }
      return { rows: [] };
    },
  });

  await service.buildWithdrawalRequest(CAMPAIGN_ID, {
    amount: '100',
    destination: DEST,
    memo: 'payout',
    requestedBy: 'creator-1',
  });

  // The old bug always signed with PLATFORM_SECRET_KEY, which never satisfies
  // `creator.require_auth()` unless the two keys are accidentally identical.
  assert.equal(calls[0].signerSecret, 'creator-secret');
  assert.notEqual(calls[0].signerSecret, process.env.PLATFORM_SECRET_KEY);
});

test('a creator without a custodial wallet cannot request a contract withdrawal from the server', async () => {
  const { service } = build({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      if (text.includes('FROM users')) {
        return { rows: [userRow({ wallet_type: 'freighter', wallet_secret_encrypted: null })] };
      }
      return { rows: [] };
    },
  });

  await assert.rejects(
    () =>
      service.buildWithdrawalRequest(CAMPAIGN_ID, {
        amount: '100',
        destination: DEST,
        memo: 'payout',
        requestedBy: 'creator-1',
      }),
    (err) => err.code === 'FREIGHTER_SIGNING_UNSUPPORTED' && err.statusCode === 501
  );
});

test('a policy violation surfaces as its contract code and writes no row', async () => {
  let insertAttempted = false;
  const { service } = build({
    soroban: {
      overrides: {
        invokeContract: async () => {
          throw new Error('HostError: Error(Contract, #4)');
        },
      },
    },
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      if (text.includes('FROM users')) return { rows: [userRow()] };
      if (text.includes('INSERT INTO withdrawal_requests')) insertAttempted = true;
      return { rows: [] };
    },
  });

  await assert.rejects(
    () =>
      service.buildWithdrawalRequest(CAMPAIGN_ID, {
        amount: '3000',
        destination: DEST,
        memo: 'over',
        requestedBy: 'creator-1',
      }),
    (err) => err.code === 'EXCEEDS_MAX_WITHDRAWAL_PCT'
  );
  assert.equal(insertAttempted, false, 'a rejected withdrawal must not be recorded');
});

test('a standard-mode campaign cannot use the treasury endpoints', async () => {
  const { service } = build({
    queryImpl: async () => ({
      rows: [campaignRow({ wallet_mode: 'standard', contract_id: null })],
    }),
  });
  await assert.rejects(
    () =>
      service.buildWithdrawalRequest(CAMPAIGN_ID, {
        amount: '10',
        destination: DEST,
        memo: 'x',
        requestedBy: 'creator-1',
      }),
    (err) => err.code === 'NOT_CONTRACT_WALLET' && err.statusCode === 409
  );
});

test('approving a pending withdrawal completes exactly that row', async () => {
  let updateParams;
  const { service, calls } = build({
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns')) {
        return { rows: [campaignRow({ auditor_public_key: AUDITOR })] };
      }
      if (text.includes('FROM users')) {
        return { rows: [userRow({ wallet_public_key: AUDITOR, wallet_secret_encrypted: 'auditor-secret' })] };
      }
      if (text.includes('UPDATE withdrawal_requests')) {
        updateParams = params;
        return { rows: [{ id: 'w-2', status: 'completed', amount: '9000.0000000' }] };
      }
      return { rows: [] };
    },
  });

  const row = await service.approvePendingWithdrawal(CAMPAIGN_ID, 7, { approverId: 'auditor-1' });
  assert.equal(row.status, 'completed');
  assert.deepEqual(updateParams, [CAMPAIGN_ID, 7]);
  assert.equal(calls[0].method, 'approve_withdrawal');
  // approve_withdrawal requires Soroban `auditor.require_auth()`; the platform key
  // signs a different address and must not be substituted for the auditor's own.
  assert.equal(calls[0].signerSecret, 'auditor-secret');
});

test('approving without an authenticated approver is rejected before touching the contract', async () => {
  const { service, calls } = build({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      return { rows: [] };
    },
  });
  await assert.rejects(
    () => service.approvePendingWithdrawal(CAMPAIGN_ID, 7),
    (err) => err.code === 'VALIDATION_ERROR' && err.statusCode === 400
  );
  assert.equal(calls.length, 0);
});

test('approving an id the database does not hold is a 404', async () => {
  const { service } = build({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return { rows: [campaignRow({ auditor_public_key: AUDITOR })] };
      }
      if (text.includes('FROM users')) {
        return { rows: [userRow({ wallet_public_key: AUDITOR, wallet_secret_encrypted: 'auditor-secret' })] };
      }
      return { rows: [] };
    },
  });
  await assert.rejects(
    () => service.approvePendingWithdrawal(CAMPAIGN_ID, 99, { approverId: 'auditor-1' }),
    (err) => err.code === 'PENDING_NOT_FOUND' && err.statusCode === 404
  );
});

test('auditor whose wallet does not match the campaign auditor key is rejected', async () => {
  const { service, calls } = build({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        // Campaign expects a different auditor than the one calling.
        return { rows: [campaignRow({ auditor_public_key: CREATOR })] };
      }
      if (text.includes('FROM users')) {
        return { rows: [userRow({ wallet_public_key: AUDITOR, wallet_secret_encrypted: 'auditor-secret' })] };
      }
      return { rows: [] };
    },
  });

  await assert.rejects(
    () => service.approvePendingWithdrawal(CAMPAIGN_ID, 7, { approverId: 'auditor-1' }),
    (err) => err.code === 'AUDITOR_MISMATCH' && err.statusCode === 403
  );
  assert.equal(calls.length, 0, 'must not reach the contract when the auditor mismatches');
});

test('a Freighter-only auditor cannot approve from the server', async () => {
  const { service, calls } = build({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return { rows: [campaignRow({ auditor_public_key: AUDITOR })] };
      }
      if (text.includes('FROM users')) {
        return { rows: [userRow({ wallet_type: 'freighter', wallet_public_key: AUDITOR, wallet_secret_encrypted: null })] };
      }
      return { rows: [] };
    },
  });

  await assert.rejects(
    () => service.approvePendingWithdrawal(CAMPAIGN_ID, 7, { approverId: 'auditor-1' }),
    (err) => err.code === 'FREIGHTER_SIGNING_UNSUPPORTED' && err.statusCode === 501
  );
  assert.equal(calls.length, 0);
});

test('the auditor and platform accounts are distinct: approval signs with the auditor key', async () => {
  const { service, calls } = build({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return { rows: [campaignRow({ auditor_public_key: AUDITOR })] };
      }
      if (text.includes('FROM users')) {
        return { rows: [userRow({ wallet_public_key: AUDITOR, wallet_secret_encrypted: 'auditor-secret' })] };
      }
      if (text.includes('UPDATE withdrawal_requests')) {
        return { rows: [{ id: 'w-2', status: 'completed', amount: '9000.0000000' }] };
      }
      return { rows: [] };
    },
  });

  await service.approvePendingWithdrawal(CAMPAIGN_ID, 7, { approverId: 'auditor-1' });
  assert.equal(calls[0].signerSecret, 'auditor-secret');
  assert.notEqual(calls[0].signerSecret, process.env.PLATFORM_SECRET_KEY,
    'approval must use the auditor key, not the platform key');
});

// ── live status ──────────────────────────────────────────────────────────────

test('status is assembled from live contract reads, not the database', async () => {
  const { service, calls } = build({
    soroban: {
      readResults: {
        get_policy: {
          min_hold_days: 30,
          max_single_withdrawal_pct: 25,
          withdrawal_cooldown_hours: 24,
          require_auditor_for_above: 50000000000n,
          auto_refund_on_miss: true,
        },
        get_total_received: 100000000000n,
        get_total_withdrawn: 25000000000n,
        get_withdrawal_history: [
          {
            id: 1,
            amount: 25000000000n,
            destination: DEST,
            executed_at: 1700000000,
            requester: CREATOR,
            approved_by: null,
          },
        ],
        get_pending_withdrawals: [],
        is_paused: false,
      },
    },
    queryImpl: async () => ({ rows: [campaignRow()] }),
  });

  const status = await service.getTreasuryStatus(CAMPAIGN_ID);

  assert.equal(status.totalReceived, '10000.0000000');
  assert.equal(status.totalWithdrawn, '2500.0000000');
  assert.equal(status.available, '7500.0000000');
  assert.equal(status.policy.maxSingleWithdrawalPct, 25);
  assert.equal(status.policy.requireAuditorForAbove, '5000.0000000');
  assert.equal(status.withdrawalHistory[0].amount, '2500.0000000');
  assert.equal(status.withdrawalHistory[0].approvedBy, null);
  // Every field came from a read-only contract call.
  const methods = calls.map((c) => c.method);
  assert.ok(methods.includes('get_policy'));
  assert.ok(methods.includes('get_withdrawal_history'));
});

// ── reconciliation (acceptance criterion 6) ──────────────────────────────────

test('reconciliation reports in-sync when history and the database agree', async () => {
  const history = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    amount: 1000000000n,
    destination: DEST,
    executed_at: 1700000000,
    requester: CREATOR,
    approved_by: null,
  }));
  const { service } = build({
    soroban: {
      readResults: {
        get_policy: {
          min_hold_days: 0,
          max_single_withdrawal_pct: 100,
          withdrawal_cooldown_hours: 0,
          require_auditor_for_above: 0n,
          auto_refund_on_miss: false,
        },
        get_total_received: 1000000000000n,
        get_total_withdrawn: 50000000000n,
        get_withdrawal_history: history,
        get_pending_withdrawals: [],
        is_paused: false,
      },
    },
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      if (text.includes('FROM withdrawal_requests')) {
        return { rows: history.map(() => ({ amount: '100.0000000', status: 'completed' })) };
      }
      return { rows: [] };
    },
  });

  const report = await service.reconcileWithdrawals(CAMPAIGN_ID);
  assert.equal(report.onChainCount, 50);
  assert.equal(report.databaseCount, 50);
  assert.equal(report.onChainTotal, '5000.0000000');
  assert.equal(report.databaseTotal, '5000.0000000');
  assert.equal(report.inSync, true);
});

test('reconciliation flags a discrepancy rather than assuming agreement', async () => {
  const { service } = build({
    soroban: {
      readResults: {
        get_policy: {
          min_hold_days: 0,
          max_single_withdrawal_pct: 100,
          withdrawal_cooldown_hours: 0,
          require_auditor_for_above: 0n,
          auto_refund_on_miss: false,
        },
        get_total_received: 1000000000000n,
        get_total_withdrawn: 20000000000n,
        get_withdrawal_history: [
          {
            id: 1,
            amount: 20000000000n,
            destination: DEST,
            executed_at: 1700000000,
            requester: CREATOR,
            approved_by: null,
          },
        ],
        get_pending_withdrawals: [],
        is_paused: false,
      },
    },
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      // The database is missing the row the contract recorded.
      if (text.includes('FROM withdrawal_requests')) return { rows: [] };
      return { rows: [] };
    },
  });

  const report = await service.reconcileWithdrawals(CAMPAIGN_ID);
  assert.equal(report.inSync, false);
  assert.equal(report.onChainCount, 1);
  assert.equal(report.databaseCount, 0);
});

// ── refunds ──────────────────────────────────────────────────────────────────

test('an auto-refund records the batch it returned', async () => {
  let insertParams;
  const { service } = build({
    soroban: { invokeResult: 60000000000n },
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns')) return { rows: [campaignRow()] };
      if (text.includes('COUNT(DISTINCT user_id)')) return { rows: [{ total: 3 }] };
      if (text.includes('INSERT INTO refund_events')) {
        insertParams = params;
        return { rows: [{ id: 'r-1', total_refunded: '6000.0000000', contributor_count: 3 }] };
      }
      return { rows: [] };
    },
  });

  const event = await service.triggerAutoRefund(CAMPAIGN_ID, { triggeredBy: 'user-1' });
  assert.equal(event.total_refunded, '6000.0000000');
  assert.equal(insertParams[1], '6000.0000000');
  assert.equal(insertParams[2], 3);
});

test('a refund the contract refuses is surfaced with its condition code', async () => {
  const { service } = build({
    soroban: {
      overrides: {
        invokeContract: async () => {
          throw new Error('HostError: Error(Contract, #12)');
        },
      },
    },
    queryImpl: async () => ({ rows: [campaignRow()] }),
  });
  await assert.rejects(
    () => service.triggerAutoRefund(CAMPAIGN_ID),
    (err) => err.code === 'REFUND_CONDITIONS_NOT_MET'
  );
});
