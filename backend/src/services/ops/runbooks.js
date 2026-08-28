/**
 * runbooks.js
 *
 * Automated runbook executor for CrowdPay Operations Centre.
 * Implements remediation procedures for platform wallet low balance,
 * dropped SSE streams, stuck pending contributions, and underfunded campaign reserves.
 */

const {
  TransactionBuilder,
  FeeBumpTransaction,
  Keypair,
  Networks,
} = require('@stellar/stellar-sdk');
const db = require('../../config/database');
const logger = require('../../config/logger');
const { server, isTestnet } = require('../../config/stellar');
const {
  cleanupStreamForWallet,
  watchCampaignWallet,
} = require('../ledgerMonitor');
const {
  auditPlatformWallet,
  auditCampaignWallets,
  getPlatformPublicKey,
} = require('./healthCollector');

// Global flag to pause withdrawal co-signing if platform wallet is severely low
let withdrawalCoSigningBlocked = false;

function isWithdrawalCoSigningBlocked() {
  return withdrawalCoSigningBlocked;
}

function setWithdrawalCoSigningBlocked(blocked) {
  withdrawalCoSigningBlocked = !!blocked;
}

/**
 * Runbook: Refund Platform Wallet
 */
async function runbookRefundPlatformWallet(incident, logStep) {
  logStep('1. Diagnose Platform Balance', 'running', 'Inspecting platform account balance and pending operations...');
  const platformAudit = await auditPlatformWallet();
  const balance = platformAudit.balance_xlm;
  const pendingCount = platformAudit.pending_transactions_count;
  const estimatedXlm = platformAudit.estimated_xlm_needed;

  logStep(
    '1. Diagnose Platform Balance',
    'completed',
    `Current balance: ${balance} XLM. Pending transactions: ${pendingCount}. Estimated XLM needed: ${estimatedXlm} XLM.`
  );

  logStep('2. Enforce Operational Safety', 'running', 'Blocking new withdrawal co-signing to prevent fee exhaustion...');
  setWithdrawalCoSigningBlocked(true);
  logStep('2. Enforce Operational Safety', 'completed', 'Withdrawal co-signing temporarily blocked until wallet is funded.');

  logStep('3. Generate Operator Top-up Instruction', 'running', 'Generating manual top-up transfer instructions...');
  const pubKey = platformAudit.public_key || 'UNKNOWN_PUBLIC_KEY';
  const instructions = `Manual Action Required: Please transfer at least ${(estimatedXlm + 20).toFixed(2)} XLM to platform co-signing address ${pubKey} on ${isTestnet ? 'Testnet' : 'Public'} network. Once funded, acknowledge or rerun health check.`;
  
  logStep('3. Generate Operator Top-up Instruction', 'completed', instructions);

  return {
    status: 'requires_manual_action',
    action_required: instructions,
    platform_public_key: pubKey,
    deficit_estimate_xlm: estimatedXlm,
  };
}

/**
 * Runbook: Restart SSE Stream
 */
async function runbookRestartSseStream(incident, logStep) {
  logStep('1. Discover Dropped Streams', 'running', 'Querying campaigns with active/funded status...');
  const { rows: campaigns } = await db.query(
    `SELECT c.id, c.title, c.wallet_public_key, lc.last_cursor
     FROM campaigns c
     LEFT JOIN ledger_stream_cursors lc ON lc.campaign_id = c.id
     WHERE c.status IN ('active', 'funded') AND c.wallet_public_key IS NOT NULL`
  );

  logStep('1. Discover Dropped Streams', 'completed', `Found ${campaigns.length} active campaigns to verify.`);

  let reconnectedCount = 0;
  for (const c of campaigns) {
    logStep(
      `2. Reset Stream for ${c.wallet_public_key.slice(0, 8)}...`,
      'running',
      `Cleaning up existing connection and loading cursor ${c.last_cursor || 'now'}...`
    );

    cleanupStreamForWallet(c.wallet_public_key);

    try {
      watchCampaignWallet({
        campaignId: c.id,
        walletPublicKey: c.wallet_public_key,
        cursor: c.last_cursor || undefined,
      });
      reconnectedCount++;
      logStep(
        `2. Reset Stream for ${c.wallet_public_key.slice(0, 8)}...`,
        'completed',
        `SSE listener re-established successfully from cursor ${c.last_cursor || 'now'}.`
      );
    } catch (err) {
      logStep(
        `2. Reset Stream for ${c.wallet_public_key.slice(0, 8)}...`,
        'failed',
        `Failed to reconnect: ${err.message}`
      );
    }
  }

  return {
    status: 'completed',
    reconnected_count: reconnectedCount,
    total_campaigns: campaigns.length,
  };
}

/**
 * Runbook: Resubmit Stuck Contributions
 */
async function runbookResubmitStuckContribution(incident, logStep) {
  logStep('1. Identify Stuck Pending Contributions', 'running', 'Searching for contributions pending > 5 minutes...');
  const { rows: stuck } = await db.query(
    `SELECT id, campaign_id, tx_hash, amount, asset, created_at
     FROM contributions
     WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'
     ORDER BY created_at ASC
     LIMIT 25`
  );

  logStep('1. Identify Stuck Pending Contributions', 'completed', `Found ${stuck.length} stuck contribution(s).`);

  let resolvedCount = 0;
  let resubmittedCount = 0;

  for (const item of stuck) {
    logStep(
      `2. Inspect Contribution ${item.id}`,
      'running',
      `Checking Horizon for transaction hash ${item.tx_hash || 'N/A'}...`
    );

    if (item.tx_hash) {
      try {
        const tx = await server.transactions().transaction(item.tx_hash).call();
        if (tx && tx.successful) {
          await db.query(
            `UPDATE contributions
             SET status = 'indexed', updated_at = NOW()
             WHERE id = $1`,
            [item.id]
          );
          resolvedCount++;
          logStep(
            `2. Inspect Contribution ${item.id}`,
            'completed',
            `Transaction was confirmed on-chain. Updated status to indexed.`
          );
          continue;
        }
      } catch (err) {
        // Horizon 404 means transaction was not ingested
      }
    }

    // Try finding signed XDR in stellar_transactions
    let txRecord = null;
    try {
      const { rows: records } = await db.query(
        `SELECT id, signed_xdr, unsigned_xdr, kind
         FROM stellar_transactions
         WHERE (tx_hash = $1 OR campaign_id = $2) AND status = 'submitted'
         ORDER BY created_at DESC LIMIT 1`,
        [item.tx_hash, item.campaign_id]
      );
      if (records.length > 0) txRecord = records[0];
    } catch {
      // ignore
    }

    if (txRecord && txRecord.signed_xdr && process.env.PLATFORM_SECRET_KEY) {
      logStep(
        `3. Fee-Bump & Resubmit ${item.id}`,
        'running',
        'Constructing FeeBumpTransaction with higher network fee...'
      );

      try {
        const platformKp = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
        const innerTx = TransactionBuilder.fromXDR(
          txRecord.signed_xdr,
          isTestnet ? Networks.TESTNET : Networks.PUBLIC
        );

        const feeBump = TransactionBuilder.buildFeeBumpTransaction(
          platformKp,
          '1000000', // 0.1 XLM fee
          innerTx,
          isTestnet ? Networks.TESTNET : Networks.PUBLIC
        );

        feeBump.sign(platformKp);
        await server.submitTransaction(feeBump);

        resubmittedCount++;
        logStep(
          `3. Fee-Bump & Resubmit ${item.id}`,
          'completed',
          `Successfully submitted fee-bump transaction to Horizon.`
        );
      } catch (err) {
        logStep(
          `3. Fee-Bump & Resubmit ${item.id}`,
          'failed',
          `Fee-bump submission failed: ${err.message}`
        );
      }
    } else {
      logStep(
        `2. Inspect Contribution ${item.id}`,
        'completed',
        `No replayable XDR found for tx_hash ${item.tx_hash || 'null'}. Marked for review.`
      );
    }
  }

  return {
    status: 'completed',
    stuck_found: stuck.length,
    indexed_confirmed: resolvedCount,
    fee_bumped_resubmitted: resubmittedCount,
  };
}

/**
 * Runbook: Fund Underfunded Campaign Wallet
 */
async function runbookFundUnderfundedWallet(incident, logStep) {
  logStep('1. Audit Campaign Wallet Reserves', 'running', 'Auditing active campaign reserves on Stellar Horizon...');
  const audit = await auditCampaignWallets();
  const underfunded = audit.wallets.filter((w) => w.deficit_xlm > 0);

  logStep(
    '1. Audit Campaign Wallet Reserves',
    'completed',
    `Found ${underfunded.length} underfunded wallet(s) requiring top-up.`
  );

  if (underfunded.length === 0) {
    return {
      status: 'completed',
      message: 'All campaign wallets meet base reserve requirements.',
    };
  }

  const instructions = underfunded.map((w) => ({
    campaign_id: w.campaign_id,
    campaign_title: w.campaign_title,
    wallet_public_key: w.wallet_public_key,
    deficit_xlm: w.deficit_xlm,
    min_required_xlm: w.min_required_xlm,
    current_balance_xlm: w.balance_xlm,
  }));

  logStep(
    '2. Prepare Funding Instructions',
    'running',
    `Generated funding proposal for ${underfunded.length} wallet(s). Total deficit: ${underfunded.reduce((acc, u) => acc + u.deficit_xlm, 0).toFixed(7)} XLM.`
  );

  // In accordance with safety rules, funding reserve transfers requires manual operator approval
  const webhookUrl = process.env.OPS_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'runbook.approval_required',
          runbook_type: 'runbook_fund_underfunded_wallet',
          incident_id: incident?.id,
          deficit_summary: instructions,
        }),
      });
    } catch {
      // ignore
    }
  }

  logStep(
    '2. Prepare Funding Instructions',
    'completed',
    'Funding plan prepared. Operator approval required to trigger automated platform transfer.'
  );

  return {
    status: 'requires_manual_action',
    action_required: 'Operator approval required to transfer reserve deficits.',
    underfunded_wallets: instructions,
  };
}

/**
 * Map runbook type to implementation handler.
 */
const RUNBOOK_MAP = {
  runbook_refund_platform_wallet: runbookRefundPlatformWallet,
  runbook_restart_sse_stream: runbookRestartSseStream,
  runbook_resubmit_stuck_contribution: runbookResubmitStuckContribution,
  runbook_fund_underfunded_wallet: runbookFundUnderfundedWallet,
};

/**
 * Determine best runbook for an incident type.
 */
function getSuggestedRunbookForIncident(incidentType) {
  switch (incidentType) {
    case 'platform_wallet_low_xlm':
      return 'runbook_refund_platform_wallet';
    case 'sse_stream_dropped':
      return 'runbook_restart_sse_stream';
    case 'stuck_pending_contributions':
      return 'runbook_resubmit_stuck_contribution';
    case 'campaign_wallet_underfunded':
      return 'runbook_fund_underfunded_wallet';
    default:
      return null;
  }
}

/**
 * Execute automated runbook and record steps in database.
 */
async function executeRunbook(incidentId, runbookType) {
  let incident = null;
  if (incidentId) {
    try {
      const { rows } = await db.query('SELECT * FROM incidents WHERE id = $1', [incidentId]);
      if (rows.length > 0) incident = rows[0];
    } catch {
      // ignore
    }
  }

  const selectedRunbook = runbookType || (incident ? getSuggestedRunbookForIncident(incident.incident_type) : null);
  if (!selectedRunbook || !RUNBOOK_MAP[selectedRunbook]) {
    throw new Error(`Invalid or unsupported runbook type: ${selectedRunbook || 'none'}`);
  }

  // Insert execution record
  const steps = [];
  let executionId = null;

  try {
    const { rows } = await db.query(
      `INSERT INTO runbook_executions (incident_id, runbook_type, status, steps, started_at)
       VALUES ($1, $2, 'running', '[]'::jsonb, NOW())
       RETURNING id, incident_id, runbook_type, status, steps, started_at`,
      [incident?.id || null, selectedRunbook]
    );
    if (rows.length > 0) executionId = rows[0].id;
  } catch (err) {
    logger.warn('Could not insert runbook_execution record', { error: err.message });
  }

  const logStep = (name, status, log) => {
    const stepEntry = {
      name,
      status,
      log,
      executedAt: new Date().toISOString(),
    };
    const existingIdx = steps.findIndex((s) => s.name === name);
    if (existingIdx >= 0) {
      steps[existingIdx] = stepEntry;
    } else {
      steps.push(stepEntry);
    }
    logger.info(`Runbook Step [${selectedRunbook}] ${name}: ${status} - ${log}`);
  };

  let executionResult = null;
  let finalStatus = 'completed';

  try {
    const handler = RUNBOOK_MAP[selectedRunbook];
    executionResult = await handler(incident, logStep);
    if (executionResult && executionResult.status) {
      finalStatus = executionResult.status;
    }
  } catch (err) {
    finalStatus = 'failed';
    logStep('Execution Error', 'failed', `Runbook failed with error: ${err.message}`);
    logger.error('Runbook execution error', { runbook: selectedRunbook, error: err.message });
  }

  // Update DB execution record
  if (executionId) {
    try {
      await db.query(
        `UPDATE runbook_executions
         SET status = $1, steps = $2::jsonb, completed_at = NOW()
         WHERE id = $3`,
        [finalStatus, JSON.stringify(steps), executionId]
      );
    } catch (err) {
      logger.error('Failed to update runbook execution status', { id: executionId, error: err.message });
    }
  }

  return {
    id: executionId,
    incident_id: incident?.id || null,
    runbook_type: selectedRunbook,
    status: finalStatus,
    steps,
    result: executionResult,
    completed_at: new Date().toISOString(),
  };
}

module.exports = {
  executeRunbook,
  getSuggestedRunbookForIncident,
  isWithdrawalCoSigningBlocked,
  setWithdrawalCoSigningBlocked,
  RUNBOOK_MAP,
  runbookRefundPlatformWallet,
  runbookRestartSseStream,
  runbookResubmitStuckContribution,
  runbookFundUnderfundedWallet,
};
