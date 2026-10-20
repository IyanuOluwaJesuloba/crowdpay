/**
 * Sponsor matching service.
 *
 * All monetary amounts are handled as BigInt stroops internally (1 unit =
 * 10^7 stroops, matching Stellar's 7-decimal precision).  The single
 * conversion boundary is the public API surface:
 *
 *   • Inbound  – a validated decimal string is converted to BigInt stroops
 *                by `toStroops` once and never touched as a JS number again.
 *   • Outbound – BigInt stroops are serialised to a canonical 7-decimal
 *                string by `fromStroops` immediately before the value leaves
 *                this module.
 *
 * This eliminates the `parseFloat / toFixed` drift that caused pool
 * over-spending and required the data-repair UPDATE in migration
 * 20260930_sponsor_matching_hardening.sql (#1064).
 */

const db = require('../config/database');
const logger = require('../config/logger');
const { toStroops, fromStroops, AmountError } = require('../utils/stroops');

/**
 * Thrown when a sponsor already holds an active matching pledge for a campaign.
 * The unique index added in 20260930_sponsor_matching_hardening.sql makes this
 * deterministic even under concurrent requests, so the API can answer with a
 * stable 409 instead of racing on a read-then-insert check.
 */
class DuplicateMatchingPledgeError extends Error {
  constructor() {
    super('Sponsor already has an active matching pledge for this campaign');
    this.name = 'DuplicateMatchingPledgeError';
    this.code = 'DUPLICATE_MATCHING_PLEDGE';
  }
}

function isDuplicatePledgeViolation(err) {
  return (
    err &&
    err.code === '23505' &&
    typeof err.constraint === 'string' &&
    err.constraint.includes('campaign_matches_active_sponsor')
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a DB NUMERIC string (or number) to BigInt stroops.
 * Throws AmountError on malformed input; passes `allowZero` through so that
 * `matched_amount = 0` rows are accepted.
 */
function dbAmountToStroops(value, { allowZero = false } = {}) {
  return toStroops(String(value), { allowZero });
}

/**
 * Apply match_ratio (stored as NUMERIC(10,2)) to a contribution amount in
 * stroops.  The ratio is multiplied as fixed-point integer arithmetic:
 *
 *   match_ratio is a decimal like "1.00" or "2.50".
 *   We parse it as (integer * 100 + fraction) / 100 to stay in BigInt land.
 *
 *   result = floor(contributionStroops * ratioNumerator / 100)
 *
 * Floor is the correct rounding direction: we must never credit more than the
 * sponsor offered.
 */
function applyRatio(contributionStroops, matchRatioString) {
  // matchRatioString is e.g. "1.00", "2.50", "0.50".
  const ratioStr = String(matchRatioString).trim();
  const dotIdx = ratioStr.indexOf('.');
  let ratioNumerator;
  if (dotIdx === -1) {
    // Integer ratio — no decimal part.
    ratioNumerator = BigInt(ratioStr) * 100n;
  } else {
    const intPart = ratioStr.slice(0, dotIdx) || '0';
    // Pad / truncate fractional part to exactly 2 digits (matches NUMERIC(10,2)).
    const fracRaw = ratioStr.slice(dotIdx + 1);
    const fracPart = fracRaw.slice(0, 2).padEnd(2, '0');
    ratioNumerator = BigInt(intPart) * 100n + BigInt(fracPart);
  }
  // floor division: never over-credit.
  return (contributionStroops * ratioNumerator) / 100n;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Create a sponsor matching pledge for a campaign.
 *
 * `pledgeAmount` must be a decimal string that is exactly representable in
 * Stellar stroops (at most 7 fractional digits).  It is validated here and
 * stored in the DB as a NUMERIC(20,7) canonical 7-decimal string.
 *
 * @param {Object} params
 * @param {string}        params.campaignId     - Campaign UUID
 * @param {string}        params.sponsorUserId  - Sponsor user UUID
 * @param {number|string} params.matchRatio     - Match multiplier (e.g. 1, 2.5)
 * @param {string}        params.pledgeAmount   - Total pool in campaign asset (decimal string)
 * @param {Object}        [params.client]       - Optional transaction client
 * @returns {Promise<Object>} Created campaign_matches row (amounts as decimal strings)
 */
async function createMatchingPledge({
  campaignId,
  sponsorUserId,
  matchRatio,
  pledgeAmount,
  client,
}) {
  if (!campaignId || !sponsorUserId) {
    throw new Error('campaignId and sponsorUserId are required');
  }
  if (!matchRatio || Number(matchRatio) <= 0) {
    throw new Error('matchRatio must be positive');
  }

  // Validate and normalise pledgeAmount to canonical 7-decimal string at the
  // boundary.  AmountError (bad format, zero, negative, too-precise, too-large)
  // propagates as a 400 to the caller.
  let pledgeStroops;
  try {
    pledgeStroops = toStroops(String(pledgeAmount));
  } catch (err) {
    if (err instanceof AmountError) {
      throw new Error(`pledgeAmount is invalid: ${err.message}`);
    }
    throw err;
  }
  const normalisedPledge = fromStroops(pledgeStroops); // "1000.0000000"

  const runner = client || db;

  // Fast path: reject an obvious duplicate before touching the unique index so
  // callers without a transaction still get a clean error.
  const { rows: existing } = await runner.query(
    `SELECT id FROM campaign_matches
     WHERE campaign_id = $1 AND sponsor_user_id = $2 AND status = 'active'`,
    [campaignId, sponsorUserId]
  );

  if (existing.length > 0) {
    throw new DuplicateMatchingPledgeError();
  }

  let rows;
  try {
    ({ rows } = await runner.query(
      `INSERT INTO campaign_matches
         (campaign_id, sponsor_user_id, match_ratio, pledge_amount, matched_amount, status)
       VALUES ($1, $2, $3, $4, 0, 'active')
       RETURNING id, campaign_id, sponsor_user_id, match_ratio, pledge_amount,
                 matched_amount, status, created_at`,
      [campaignId, sponsorUserId, matchRatio, normalisedPledge]
    ));
  } catch (err) {
    if (isDuplicatePledgeViolation(err)) {
      throw new DuplicateMatchingPledgeError();
    }
    throw err;
  }

  logger.info('Created sponsor matching pledge', {
    campaignId,
    sponsorUserId,
    matchId: rows[0].id,
    pledgeAmount: normalisedPledge,
    matchRatio,
  });

  return rows[0];
}

/**
 * Process a contribution and apply matching funds if applicable.
 * Returns the matched amount as a canonical 7-decimal string ("0.0000000" when
 * no matching occurs), never a JS number.
 *
 * The active pool row is locked with `FOR UPDATE` so two contributions landing
 * at the same time cannot both spend the same pool capacity, and the
 * contribution is claimed exactly once (guarded by `match_amount = 0`) so a
 * replayed/duplicated indexing pass cannot double-match or double-credit it.
 *
 * @param {Object} params
 * @param {string}        params.campaignId          - Campaign UUID
 * @param {string}        params.contributionId      - Contribution UUID
 * @param {string|number} params.contributionAmount  - Amount contributed (decimal string)
 * @param {Object}        [params.client]            - Optional transaction client
 * @returns {Promise<string>} Canonical 7-decimal matched amount string
 */
async function processContributionMatch({
  campaignId,
  contributionId,
  contributionAmount,
  client,
}) {
  if (!campaignId || !contributionId || contributionAmount == null) {
    throw new Error('campaignId, contributionId, and contributionAmount are required');
  }

  // Single conversion at the validated boundary.
  let contributionStroops;
  try {
    contributionStroops = toStroops(String(contributionAmount));
  } catch (err) {
    if (err instanceof AmountError) {
      throw new Error('contributionAmount must be a positive number');
    }
    throw err;
  }

  const runner = client || db;

  // Lock the oldest pool that still has capacity.  Pools that are already
  // exhausted are skipped here as well as at write time so stale `active`
  // status rows cannot silently absorb a contribution.
  const { rows: matches } = await runner.query(
    `SELECT id, match_ratio, pledge_amount, matched_amount
     FROM campaign_matches
     WHERE campaign_id = $1
       AND status = 'active'
       AND matched_amount < pledge_amount
     ORDER BY created_at ASC, id ASC
     LIMIT 1
     FOR UPDATE`,
    [campaignId]
  );

  if (!matches.length) {
    return fromStroops(0n); // "0.0000000"
  }

  const match = matches[0];

  // All arithmetic in BigInt stroops — no floating point.
  const pledgeStroops = dbAmountToStroops(match.pledge_amount);
  const matchedSoFarStroops = dbAmountToStroops(match.matched_amount, { allowZero: true });

  const remainingPool = pledgeStroops - matchedSoFarStroops;
  if (remainingPool <= 0n) {
    return fromStroops(0n);
  }

  const calculatedMatch = applyRatio(contributionStroops, match.match_ratio);
  // Cap at remaining pool; never over-credit.
  const actualMatchStroops = calculatedMatch < remainingPool ? calculatedMatch : remainingPool;

  if (actualMatchStroops <= 0n) {
    return fromStroops(0n);
  }

  const actualMatchString = fromStroops(actualMatchStroops); // canonical 7-decimal

  // Claim this contribution for matching exactly once.  A second call for the
  // same contribution (retry, replayed transaction, concurrent indexer) is a
  // no-op rather than a second spend.
  const { rows: claimed } = await runner.query(
    `UPDATE contributions
     SET match_amount = $1, campaign_match_id = $2
     WHERE id = $3 AND COALESCE(match_amount, 0) = 0
     RETURNING id`,
    [actualMatchString, match.id, contributionId]
  );

  if (!claimed.length) {
    logger.info('Contribution already consumed matching funds; skipping', {
      campaignId,
      contributionId,
      matchId: match.id,
    });
    return fromStroops(0n);
  }

  // Determine exhaustion via exact BigInt comparison.
  const newMatchedStroops = matchedSoFarStroops + actualMatchStroops;
  const isExhausted = newMatchedStroops >= pledgeStroops;
  const newMatchedString = fromStroops(newMatchedStroops);

  // Update matching pool.
  await runner.query(
    `UPDATE campaign_matches
     SET matched_amount = $1,
         status = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [newMatchedString, isExhausted ? 'exhausted' : 'active', match.id]
  );

  // Sponsor funds are part of the campaign ledger: credit them in the same
  // transaction as the contribution so the campaign total and the exhaustion
  // threshold agree with the matching pool.
  await runner.query(
    `UPDATE campaigns
     SET raised_amount = raised_amount + $1,
         status = CASE
           WHEN raised_amount + $1 >= target_amount THEN 'funded'
           ELSE status
         END
     WHERE id = $2 AND deleted_at IS NULL`,
    [actualMatchString, campaignId]
  );

  logger.info('Processed contribution matching', {
    campaignId,
    contributionId,
    matchId: match.id,
    contributionAmount: fromStroops(contributionStroops),
    matchRatio: match.match_ratio,
    matchedAmount: actualMatchString,
    poolExhausted: isExhausted,
  });

  return actualMatchString;
}

/**
 * Get all matching pledges and aggregated progress for a campaign.
 *
 * The response is served by a public endpoint so it deliberately omits sponsor
 * user IDs and any other internal identifiers.  All amounts are canonical
 * 7-decimal strings — never JS floats.
 *
 * @param {string} campaignId
 * @param {Object} [params]
 * @param {Object} [params.client]
 * @returns {Promise<Object>}
 */
async function getCampaignMatchProgress(campaignId, { client } = {}) {
  const runner = client || db;

  const { rows } = await runner.query(
    `SELECT
       cm.id,
       cm.sponsor_user_id,
       u.name as sponsor_name,
       cm.match_ratio,
       cm.pledge_amount,
       cm.matched_amount,
       cm.status,
       cm.created_at,
       COUNT(c.id) as contribution_count,
       COALESCE(SUM(c.amount), 0) as total_contributed
     FROM campaign_matches cm
     LEFT JOIN users u ON cm.sponsor_user_id = u.id
     LEFT JOIN contributions c ON cm.id = c.campaign_match_id
     WHERE cm.campaign_id = $1
     GROUP BY cm.id, u.id
     ORDER BY cm.created_at ASC`,
    [campaignId]
  );

  // Aggregate in BigInt stroops — no parseFloat anywhere.
  let totalPledgedStroops = 0n;
  let totalMatchedStroops = 0n;
  const activeMatches = [];
  const exhaustedMatches = [];

  const mappedRows = rows.map(r => {
    const pledgeStroops = dbAmountToStroops(r.pledge_amount);
    const matchedStroops = dbAmountToStroops(r.matched_amount, { allowZero: true });
    const remainingStroops = pledgeStroops - matchedStroops;

    totalPledgedStroops += pledgeStroops;
    totalMatchedStroops += matchedStroops;

    if (r.status === 'active') activeMatches.push(r);
    if (r.status === 'exhausted') exhaustedMatches.push(r);

    // total_contributed is an aggregate of contribution.amount (not matching
    // amounts) — it comes from a SUM() so it may be a large decimal.  Use
    // allowZero because a pool with no contributions returns 0.
    const totalContribStroops = toStroops(String(r.total_contributed), { allowZero: true });

    return {
      id: r.id,
      sponsorName: r.sponsor_name,
      matchRatio: r.match_ratio,           // kept as DB string, exact
      pledgeAmount: fromStroops(pledgeStroops),
      matchedAmount: fromStroops(matchedStroops),
      remainingAmount: remainingStroops > 0n ? fromStroops(remainingStroops) : fromStroops(0n),
      status: r.status,
      contributionCount: parseInt(r.contribution_count, 10),
      totalContributed: fromStroops(totalContribStroops),
      createdAt: r.created_at,
    };
  });

  const remainingTotalStroops =
    totalPledgedStroops > totalMatchedStroops
      ? totalPledgedStroops - totalMatchedStroops
      : 0n;

  // percentageUsed: (totalMatched / totalPledged) * 100, rounded to 2 dp.
  // Computed in integer arithmetic to avoid float drift.
  let percentageUsed = '0.00';
  if (totalPledgedStroops > 0n) {
    // Multiply by 10000 before dividing to get 2 decimal places via integer
    // division, then format as "xx.xx".
    const scaled = (totalMatchedStroops * 10000n) / totalPledgedStroops; // 0–10000
    const whole = scaled / 100n;
    const frac = scaled % 100n;
    percentageUsed = `${whole}.${String(frac).padStart(2, '0')}`;
  }

  return {
    campaignId,
    matches: mappedRows,
    totalPledged: fromStroops(totalPledgedStroops),
    totalMatched: fromStroops(totalMatchedStroops),
    remainingPoolAmount: fromStroops(remainingTotalStroops),
    activePoolCount: activeMatches.length,
    exhaustedPoolCount: exhaustedMatches.length,
    percentageUsed,
  };
}

/**
 * Mark a matching pool as completed (campaign ended).
 * Sponsor can reclaim unmatched funds.
 *
 * @param {string} matchId
 * @param {Object} [params]
 * @param {Object} [params.client]
 * @returns {Promise<Object>} Updated match record (amounts as DB strings)
 */
async function completeMatchingPledge(matchId, { client } = {}) {
  const runner = client || db;

  const { rows } = await runner.query(
    `UPDATE campaign_matches
     SET status = 'completed', updated_at = NOW()
     WHERE id = $1 AND status IN ('active', 'exhausted')
     RETURNING *`,
    [matchId]
  );

  if (!rows.length) {
    throw new Error('Match not found or already completed');
  }

  const match = rows[0];

  // Compute unclaimed amount in BigInt stroops for safe logging.
  const pledgeStroops = dbAmountToStroops(match.pledge_amount);
  const matchedStroops = dbAmountToStroops(match.matched_amount, { allowZero: true });
  const unclaimedAmount = fromStroops(pledgeStroops - matchedStroops);

  logger.info('Completed matching pledge', {
    matchId,
    campaignId: match.campaign_id,
    sponsorUserId: match.sponsor_user_id,
    unclaimedAmount,
  });

  return match;
}

/**
 * Get matching pledges for a specific sponsor (across all campaigns).
 *
 * @param {string} sponsorUserId
 * @param {Object} [params]
 * @param {Object} [params.client]
 * @returns {Promise<Array>}
 */
async function getSponsorMatchingPledges(sponsorUserId, { client } = {}) {
  const runner = client || db;

  const { rows } = await runner.query(
    `SELECT
       cm.*,
       c.title as campaign_title,
       c.status as campaign_status,
       u.name as sponsor_name
     FROM campaign_matches cm
     JOIN campaigns c ON cm.campaign_id = c.id
     JOIN users u ON cm.sponsor_user_id = u.id
     WHERE cm.sponsor_user_id = $1
     ORDER BY cm.created_at DESC`,
    [sponsorUserId]
  );

  return rows.map(r => {
    const pledgeStroops = dbAmountToStroops(r.pledge_amount);
    const matchedStroops = dbAmountToStroops(r.matched_amount, { allowZero: true });
    const remainingStroops = pledgeStroops - matchedStroops;

    return {
      id: r.id,
      campaignId: r.campaign_id,
      campaignTitle: r.campaign_title,
      campaignStatus: r.campaign_status,
      sponsorUserId: r.sponsor_user_id,
      sponsorName: r.sponsor_name,
      matchRatio: r.match_ratio,           // kept as DB string, exact
      pledgeAmount: fromStroops(pledgeStroops),
      matchedAmount: fromStroops(matchedStroops),
      remainingAmount: remainingStroops > 0n ? fromStroops(remainingStroops) : fromStroops(0n),
      status: r.status,
      contractId: r.contract_id,
      createdAt: r.created_at,
    };
  });
}

module.exports = {
  createMatchingPledge,
  processContributionMatch,
  getCampaignMatchProgress,
  completeMatchingPledge,
  getSponsorMatchingPledges,
  DuplicateMatchingPledgeError,
};
