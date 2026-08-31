'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
const SCHEDULE_ID = '33333333-3333-3333-3333-333333333333';

function dueSchedule(overrides = {}) {
  return {
    id: SCHEDULE_ID,
    user_id: 'user-1',
    campaign_id: 'camp-1',
    amount: '10',
    interval: 'monthly',
    failure_count: 0,
    next_run_at: new Date(Date.now() - 60_000).toISOString(),
    email: 'donor@test.com',
    name: 'Donor',
    wallet_public_key: 'GCONTRIBUTOR',
    wallet_secret_encrypted: 'enc',
    campaign_title: 'Test Campaign',
    asset_type: 'XLM',
    campaign_wallet_public_key: 'GCAMPAIGN',
    escrow_contract_id: null,
    ...overrides,
  };
}

function buildService({ schedule = dueSchedule(), chargeImpl, queryImpl } = {}) {
  const calls = [];
  const emails = [];
  const db = {
    query: async (text, params) => {
      calls.push({ text, params });
      if (queryImpl) {
        const r = await queryImpl(text, params);
        if (r !== undefined) return r;
      }
      if (text.includes('FROM recurring_contributions rc')) return { rows: [schedule] };
      return { rows: [] };
    },
  };

  const service = proxyquire('./recurringContributionsService', {
    '../config/database': db,
    '../config/logger': silentLogger,
    './contributionService': {
      submitCustodialContribution:
        chargeImpl ||
        (async () => ({ txHash: 'tx-success' })),
    },
    './emailService': {
      sendRecurringContributionNoticeEmail: async ({ kind }) => {
        emails.push(kind);
      },
    },
  });

  return { service, calls, emails };
}

test('processRecurringContributions charges due schedules and advances them', async () => {
  let chargedWith = null;
  const { service, calls, emails } = buildService({
    chargeImpl: async (args) => {
      chargedWith = args;
      return { txHash: 'tx-success' };
    },
  });

  await service.processRecurringContributions();

  // Charge used the custodial flow with campaign + donor wallet data.
  assert.equal(chargedWith.campaignId, 'camp-1');
  assert.equal(chargedWith.walletPublicKey, 'GCONTRIBUTOR');
  assert.equal(chargedWith.campaign.wallet_public_key, 'GCAMPAIGN');
  assert.equal(chargedWith.amount, 10);
  assert.equal(chargedWith.sendAsset, 'XLM');

  // upcoming + charged notifications were sent.
  assert.deepEqual(emails.sort(), ['charged', 'upcoming']);

  // Schedule advanced and failure state cleared.
  const advance = calls.find((c) => c.text.includes('failure_count = 0'));
  assert.ok(advance, 'expected success UPDATE');
  assert.equal(advance.text.includes("'1 month'"), true);
  assert.equal(advance.params[0], SCHEDULE_ID);
});

test('processRecurringContributions records failure and applies exponential backoff', async () => {
  const { service, calls, emails } = buildService({
    schedule: dueSchedule({ failure_count: 2 }),
    chargeImpl: async () => {
      throw new Error('horizon unavailable');
    },
  });

  await service.processRecurringContributions();

  const backoff = calls.find((c) => c.text.includes('failure_count = $2'));
  assert.ok(backoff, 'expected failure UPDATE');
  assert.equal(backoff.params[1], 3); // failure_count incremented
  assert.match(backoff.params[2], /horizon unavailable/);
  // Exponential backoff: failure 3 => 30 * 2^3 = 240 minutes
  assert.equal(backoff.params[3], 240);
  assert.equal(emails.includes('failed'), true);
});

test('backoffMinutes scales exponentially and is capped at 24 hours', () => {
  const { service } = buildService();
  assert.equal(service.backoffMinutes(0), 30);
  assert.equal(service.backoffMinutes(1), 60);
  assert.equal(service.backoffMinutes(2), 120);
  // capped at one day regardless of how high the count climbs
  assert.equal(service.backoffMinutes(11), 24 * 60);
});

test('processRecurringContributions exits early with nothing due', async () => {
  const { service, calls } = buildService({
    queryImpl: async (text) => {
      if (text.includes('FROM recurring_contributions rc')) return { rows: [] };
      return { rows: [] };
    },
  });

  await service.processRecurringContributions();
  // No charge / no update runs when there are no due schedules.
  assert.ok(!calls.some((c) => c.text.includes('submitCustodialContribution')));
  assert.ok(!calls.some((c) => c.text.includes('UPDATE recurring_contributions')));
});