'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

const W = (n) => `G${n}`; // stub wallet keys

process.env.GOVERNANCE_TOKEN_ID = 'ISSUER';

// delegations[delegator] = delegate
function buildService({ delegations = {}, balances = {} }) {
  return proxyquire('./governance', {
    '../config/database': {
      query: async (text, params) => {
        // delegation reads
        if (/SELECT delegator_public_key, delegate_public_key\s*FROM governance_delegations/.test(text)) {
          const rows = Object.entries(delegations).map(([d, e]) => ({
            delegator_public_key: d,
            delegate_public_key: e,
          }));
          return { rows };
        }
        if (/FROM governance_delegations\s+WHERE delegator_public_key = \$1/.test(text)) {
          const e = delegations[params[0]];
          return { rows: e ? [{ delegator_public_key: params[0], delegate_public_key: e }] : [] };
        }
        if (/INSERT INTO governance_delegations/.test(text)) {
          return {
            rows: [{
              delegator_public_key: params[0],
              delegate_public_key: params[1],
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            }],
          };
        }
        return { rows: [] };
      },
    },
    '../config/stellar': {
      server: {
        // Account balances are mocked per-wallet by the balance map.
        loadAccount: async (publicKey) => ({
          balances: [
            { asset_code: 'CROWD', asset_issuer: 'ISSUER', balance: String(balances[publicKey] || 0) },
          ],
        }),
      },
    },
    './sorobanService': {
      invokeContract: async () => 1,
      invokeContractReadOnly: async () => null,
      nativeToScVal: (v) => v,
      scValToNative: (v) => v,
    },
    '../config/logger': silentLogger,
  });
}

test('getEffectiveVoteWeight aggregates a multi-level delegation chain', async () => {
  // A -> B -> C (C receives A's and B's power in addition to its own).
  const service = buildService({
    delegations: { [W('A')]: W('B'), [W('B')]: W('C') },
    balances: { [W('A')]: 1000, [W('B')]: 500, [W('C')]: 200 },
  });

  const weight = await service.getEffectiveVoteWeight(W('C'));
  assert.equal(weight, 1700); // own 200 + B 500 + A 1000
});

test('getEffectiveVoteWeight traverses a 5-user chain', async () => {
  const keys = [1, 2, 3, 4, 5].map((n) => W(`U${n}`));
  const delegations = {};
  const balances = {};
  // U1 -> U2 -> U3 -> U4 -> U5
  for (let i = 0; i < keys.length - 1; i += 1) {
    delegations[keys[i]] = keys[i + 1];
    balances[keys[i]] = 100;
  }
  balances[keys[keys.length - 1]] = 100;

  const service = buildService({ delegations, balances });
  const weight = await service.getEffectiveVoteWeight(keys[keys.length - 1]);
  assert.equal(weight, 500); // 5 x 100
});

test('delegators further down the chain are not double counted', async () => {
  // A -> B -> C. B is counted once even though both A and B point toward C.
  const service = buildService({
    delegations: { [W('A')]: W('C'), [W('B')]: W('C') },
    balances: { [W('A')]: 100, [W('B')]: 100, [W('C')]: 50 },
  });
  const weight = await service.getEffectiveVoteWeight(W('C'));
  assert.equal(weight, 250);
});

test('setVoteDelegation rejects self-delegation', async () => {
  const service = buildService({ delegations: {} });
  await assert.rejects(
    () => service.setVoteDelegation(W('A'), W('A')),
    (err) => err.code === 'INVALID_DELEGATION' && /yourself/.test(err.message)
  );
});

test('setVoteDelegation rejects a circular reference', async () => {
  // A -> B already exists; assigning B -> A would close a loop.
  const service = buildService({ delegations: { [W('A')]: W('B') } });
  await assert.rejects(
    () => service.setVoteDelegation(W('B'), W('A')),
    (err) => err.code === 'INVALID_DELEGATION' && /circular/.test(err.message)
  );
});

test('setVoteDelegation allows reassignment that breaks a cycle candidate', async () => {
  // A -> B holds; A reassigning to C is fine and does not create a cycle.
  const service = buildService({ delegations: { [W('A')]: W('B') } });
  const result = await service.setVoteDelegation(W('A'), W('C'));
  assert.equal(result.delegate_public_key, W('C'));
});

test('revocation returns power to the original wallet', async () => {
  let revoked = false;
  const service = proxyquire('./governance', {
    '../config/database': {
      query: async (text) => {
        if (/DELETE FROM governance_delegations/.test(text)) {
          revoked = true;
          return { rows: [{ id: 'x' }] };
        }
        return { rows: [] };
      },
    },
    '../config/stellar': {
      server: { loadAccount: async () => ({ balances: [] }) },
    },
    './sorobanService': {},
    '../config/logger': silentLogger,
  });

  const had = await service.revokeVoteDelegation(W('A'));
  assert.equal(revoked, true);
  assert.equal(had, true);
});

test('getAllTransitiveDelegatorWallets returns indirect delegators', async () => {
  const service = buildService({
    delegations: { [W('A')]: W('B'), [W('B')]: W('C'), [W('D')]: W('C') },
    balances: {},
  });
  const wallets = await service.getAllTransitiveDelegatorWallets(W('C')).then((arr) => arr.sort());
  assert.deepEqual(wallets, [W('A'), W('B'), W('D')].sort());
});