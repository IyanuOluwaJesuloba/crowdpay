'use strict';

/**
 * recurringContributionsService.js
 *
 * Cron job that fires hourly, finds active recurring contributions whose
 * next_run_at has passed, and charges them automatically (#738).
 *
 * Unlike a naive "insert a contribution row" scheduler, each due schedule is
 * run through the same custodial Stellar payment flow used for a manual
 * contribution (submitCustodialContribution), so the funds actually move and
 * the existing ledger pipeline records + indexes the payment. Notifications
 * are sent before ("upcoming") and after ("charged") each charge, and a failed
 * charge is recorded with `failure_count`/`last_error` and re-scheduled with
 * exponential backoff instead of being dropped.
 */

const db = require('../config/database');
const logger = require('../config/logger');
const { submitCustodialContribution } = require('./contributionService');
const { sendRecurringContributionNoticeEmail } = require('./emailService');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const CRON_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BASE_BACKOFF_MINUTES = 30;
const MAX_RETRY_DELAY_MINUTES = 24 * 60; // 1 day
let _timer = null;

function backoffMinutes(failureCount) {
  const expo = BASE_BACKOFF_MINUTES * 2 ** Math.min(failureCount, 10);
  return Math.min(Math.round(expo), MAX_RETRY_DELAY_MINUTES);
}

function nextIntervalSql(interval) {
  return interval === 'weekly' ? 'next_run_at + INTERVAL \'7 days\'' : 'next_run_at + INTERVAL \'1 month\'';
}

function manageUrl() {
  return `${FRONTEND_URL}/dashboard?tab=recurring`;
}

async function processRecurringContributions() {
  logger.info('recurring-contributions: checking due schedules');

  const { rows } = await db.query(
    `SELECT rc.id,
            rc.user_id,
            rc.campaign_id,
            rc.amount,
            rc.interval,
            rc.failure_count,
            rc.next_run_at,
            u.email,
            u.name,
            u.wallet_public_key,
            u.wallet_secret_encrypted,
            c.title          AS campaign_title,
            c.asset_type,
            c.wallet_public_key AS campaign_wallet_public_key,
            c.escrow_contract_id
     FROM recurring_contributions rc
     JOIN users     u ON u.id = rc.user_id
     JOIN campaigns c ON c.id = rc.campaign_id
     WHERE rc.active = TRUE
       AND rc.next_run_at <= NOW()
       AND c.status = 'active'
       AND c.deleted_at IS NULL
     LIMIT 200`
  );

  if (!rows.length) {
    logger.debug('recurring-contributions: nothing due');
    return;
  }

  logger.info('recurring-contributions: processing', { count: rows.length });

  for (const schedule of rows) {
    const runKey = `${schedule.id}:${Date.now()}`;
    const baseParams = {
      name: schedule.name,
      campaignTitle: schedule.campaign_title,
      amount: schedule.amount,
      asset: schedule.asset_type,
      manageUrl: manageUrl(),
    };

    try {
      // 1) Notify the donor that a charge is due.
      await sendRecurringContributionNoticeEmail({
        to: schedule.email,
        kind: 'upcoming',
        recurringRunKey: runKey,
        ...baseParams,
        scheduledAt: schedule.next_run_at,
      });

      // 2) Actually execute the monthly charge through the custodial flow.
      const { txHash } = await submitCustodialContribution({
        campaign: {
          wallet_public_key: schedule.campaign_wallet_public_key,
          escrow_contract_id: schedule.escrow_contract_id,
          asset_type: schedule.asset_type,
        },
        campaignId: schedule.campaign_id,
        userId: schedule.user_id,
        walletPublicKey: schedule.wallet_public_key,
        walletSecretEncrypted: schedule.wallet_secret_encrypted,
        amount: Number(schedule.amount),
        sendAsset: schedule.asset_type,
        displayName: schedule.name,
        ipAddress: null,
        deviceFingerprint: null,
        client: null,
        tierId: null,
      });

      // 3) Confirmation for this charge.
      await sendRecurringContributionNoticeEmail({
        to: schedule.email,
        kind: 'charged',
        recurringRunKey: runKey,
        ...baseParams,
        txHash,
        campaignUrl: `${FRONTEND_URL}/campaigns/${schedule.campaign_id}`,
      });

      // 4) Advance the schedule and clear any prior failure state on success.
      await db.query(
        `UPDATE recurring_contributions
         SET last_run_at   = NOW(),
             next_run_at   = ${nextIntervalSql(schedule.interval)},
             run_count     = run_count + 1,
             failure_count = 0,
             last_error    = NULL,
             updated_at    = NOW()
         WHERE id = $1`,
        [schedule.id]
      );

      logger.info('recurring-contributions: charged', {
        schedule_id: schedule.id,
        tx_hash: txHash,
      });
    } catch (err) {
      const failures = (schedule.failure_count || 0) + 1;
      const retryMinutes = backoffMinutes(failures);
      await db.query(
        `UPDATE recurring_contributions
         SET failure_count = $2,
             last_error    = $3,
             next_run_at   = NOW() + ($4 || ' minutes')::interval,
             updated_at    = NOW()
         WHERE id = $1`,
        [schedule.id, failures, String(err && err.message || 'unknown').slice(0, 500), retryMinutes]
      );

      await sendRecurringContributionNoticeEmail({
        to: schedule.email,
        kind: 'failed',
        recurringRunKey: runKey,
        ...baseParams,
      }).catch((mailErr) =>
        logger.error('recurring-contributions: failure email could not be sent', {
          schedule_id: schedule.id,
          error: mailErr.message,
        })
      );

      logger.error('recurring-contributions: charge failed, scheduling retry', {
        schedule_id: schedule.id,
        failure_count: failures,
        next_retry_minutes: retryMinutes,
        error: err.message,
      });
    }
  }

  logger.info('recurring-contributions: done', { processed: rows.length });
}

function startRecurringContributionsCron() {
  processRecurringContributions().catch((err) =>
    logger.error('recurring-contributions: initial run failed', { error: err.message })
  );
  _timer = setInterval(() => {
    processRecurringContributions().catch((err) =>
      logger.error('recurring-contributions: cron failed', { error: err.message })
    );
  }, CRON_INTERVAL_MS);
  logger.info('recurring-contributions: cron started', { interval_ms: CRON_INTERVAL_MS });
}

function stopRecurringContributionsCron() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = {
  startRecurringContributionsCron,
  stopRecurringContributionsCron,
  processRecurringContributions,
  backoffMinutes,
};