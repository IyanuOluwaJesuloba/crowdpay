const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getSuggestedRunbookForIncident,
  isWithdrawalCoSigningBlocked,
  setWithdrawalCoSigningBlocked,
  RUNBOOK_MAP,
} = require('./runbooks');

test('getSuggestedRunbookForIncident maps incidents correctly', () => {
  assert.equal(
    getSuggestedRunbookForIncident('platform_wallet_low_xlm'),
    'runbook_refund_platform_wallet'
  );
  assert.equal(
    getSuggestedRunbookForIncident('sse_stream_dropped'),
    'runbook_restart_sse_stream'
  );
  assert.equal(
    getSuggestedRunbookForIncident('stuck_pending_contributions'),
    'runbook_resubmit_stuck_contribution'
  );
  assert.equal(
    getSuggestedRunbookForIncident('campaign_wallet_underfunded'),
    'runbook_fund_underfunded_wallet'
  );
  assert.equal(getSuggestedRunbookForIncident('unknown_type'), null);
});

test('RUNBOOK_MAP contains all required runbook handlers', () => {
  assert.ok(typeof RUNBOOK_MAP.runbook_refund_platform_wallet === 'function');
  assert.ok(typeof RUNBOOK_MAP.runbook_restart_sse_stream === 'function');
  assert.ok(typeof RUNBOOK_MAP.runbook_resubmit_stuck_contribution === 'function');
  assert.ok(typeof RUNBOOK_MAP.runbook_fund_underfunded_wallet === 'function');
});

test('withdrawal co-signing lock can be set and checked', () => {
  setWithdrawalCoSigningBlocked(false);
  assert.equal(isWithdrawalCoSigningBlocked(), false);

  setWithdrawalCoSigningBlocked(true);
  assert.equal(isWithdrawalCoSigningBlocked(), true);

  setWithdrawalCoSigningBlocked(false);
  assert.equal(isWithdrawalCoSigningBlocked(), false);
});
