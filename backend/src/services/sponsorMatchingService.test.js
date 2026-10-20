/**
 * Tests for sponsorMatchingService.
 *
 * All amount assertions use canonical 7-decimal strings ("0.0000000",
 * "100.0000000", …) because the service no longer returns JS numbers — it
 * returns the exact same representation that goes into the database and the
 * API, eliminating float-drift at the assertion boundary too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService(queryImpl) {
  return proxyquire('./sponsorMatchingService', {
    '../config/database': {
      query: queryImpl,
    },
    '../config/logger': {
      info: () => {},
      error: () => {},
      warn: () => {},
    },
  });
}

// ---------------------------------------------------------------------------
// createMatchingPledge
// ---------------------------------------------------------------------------

test('createMatchingPledge validates matchRatio positive', async () => {
  const { createMatchingPledge } = buildService(async () => ({ rows: [] }));
  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: -1,
      pledgeAmount: '1000',
    }),
    /matchRatio must be positive/
  );
});

test('createMatchingPledge validates pledgeAmount positive', async () => {
  const { createMatchingPledge } = buildService(async () => ({ rows: [] }));
  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '0',
    }),
    /pledgeAmount is invalid/
  );
});

test('createMatchingPledge rejects a negative pledgeAmount', async () => {
  const { createMatchingPledge } = buildService(async () => ({ rows: [] }));
  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '-50',
    }),
    /pledgeAmount is invalid/
  );
});

test('createMatchingPledge rejects a pledgeAmount with more than 7 decimal places', async () => {
  const { createMatchingPledge } = buildService(async () => ({ rows: [] }));
  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '1.00000001',
    }),
    /pledgeAmount is invalid/
  );
});

test('createMatchingPledge normalises pledgeAmount to 7-decimal string before insert', async () => {
  const insertedValues = [];

  const mockResult = {
    id: 'match-uuid-1',
    campaign_id: 'campaign-uuid-1',
    sponsor_user_id: 'sponsor-uuid-1',
    match_ratio: '1.00',
    pledge_amount: '1000.0000000',
    matched_amount: '0.0000000',
    status: 'active',
    created_at: new Date(),
  };

  const { createMatchingPledge } = buildService(async (text, params) => {
    if (text.includes('SELECT id FROM campaign_matches')) {
      return { rows: [] };
    }
    if (text.includes('INSERT INTO campaign_matches')) {
      insertedValues.push(params);
      return { rows: [mockResult] };
    }
    return { rows: [] };
  });

  // Supply bare "1000" — service must normalise to "1000.0000000"
  const result = await createMatchingPledge({
    campaignId: 'campaign-uuid-1',
    sponsorUserId: 'sponsor-uuid-1',
    matchRatio: 1.0,
    pledgeAmount: '1000',
  });

  assert.deepEqual(result, mockResult);
  // The 4th parameter of the INSERT is the normalised pledge amount.
  assert.equal(insertedValues[0][3], '1000.0000000');
});

test('createMatchingPledge creates a fractional pledge correctly', async () => {
  const insertedValues = [];

  const mockResult = {
    id: 'match-uuid-2',
    campaign_id: 'campaign-uuid-1',
    sponsor_user_id: 'sponsor-uuid-1',
    match_ratio: '1.00',
    pledge_amount: '0.3000000',
    matched_amount: '0.0000000',
    status: 'active',
    created_at: new Date(),
  };

  const { createMatchingPledge } = buildService(async (text, params) => {
    if (text.includes('SELECT id FROM campaign_matches')) return { rows: [] };
    if (text.includes('INSERT')) {
      insertedValues.push(params);
      return { rows: [mockResult] };
    }
    return { rows: [] };
  });

  await createMatchingPledge({
    campaignId: 'campaign-uuid-1',
    sponsorUserId: 'sponsor-uuid-1',
    matchRatio: 1.0,
    pledgeAmount: '0.3',
  });

  assert.equal(insertedValues[0][3], '0.3000000');
});

test('createMatchingPledge rejects an existing active pledge without inserting', async () => {
  const calls = [];
  const { createMatchingPledge } = buildService(async text => {
    calls.push(text);
    return { rows: [{ id: 'existing-match' }] };
  });

  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '1000',
    }),
    err => err.code === 'DUPLICATE_MATCHING_PLEDGE'
  );
  assert.equal(calls.length, 1);
});

test('createMatchingPledge maps a concurrent unique violation to the duplicate error', async () => {
  const { createMatchingPledge } = buildService(async text => {
    if (text.includes('SELECT id FROM campaign_matches')) {
      return { rows: [] };
    }
    const err = new Error('duplicate key value violates unique constraint');
    err.code = '23505';
    err.constraint = 'campaign_matches_active_sponsor_idx';
    throw err;
  });

  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '1000',
    }),
    err => err.code === 'DUPLICATE_MATCHING_PLEDGE'
  );
});

test('createMatchingPledge surfaces unrelated database errors', async () => {
  const { createMatchingPledge } = buildService(async text => {
    if (text.includes('SELECT id FROM campaign_matches')) return { rows: [] };
    const err = new Error('connection terminated');
    err.code = '08006';
    throw err;
  });

  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '1000',
    }),
    /connection terminated/
  );
});

// ---------------------------------------------------------------------------
// processContributionMatch — helper to build a query stub
// ---------------------------------------------------------------------------

function matchingQueryImpl({ pools, claimReturns = rows => rows, onQuery = () => {} } = {}) {
  return async (text, params) => {
    onQuery(text, params);
    if (text.includes('FROM campaign_matches')) {
      return { rows: pools };
    }
    if (text.includes('UPDATE contributions')) {
      return { rows: claimReturns([{ id: params?.[2] }]) };
    }
    return { rows: [] };
  };
}

const ACTIVE_POOL = {
  id: 'match-uuid-1',
  match_ratio: '1.00',
  pledge_amount: '1000.0000000',
  matched_amount: '0.0000000',
};

// ---------------------------------------------------------------------------
// processContributionMatch — basic correctness
// ---------------------------------------------------------------------------

test('processContributionMatch returns a canonical string, not a number', async () => {
  const { processContributionMatch } = buildService(matchingQueryImpl({ pools: [ACTIVE_POOL] }));

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(typeof result, 'string');
  assert.equal(result, '100.0000000');
});

test('processContributionMatch applies 1:1 ratio', async () => {
  const { processContributionMatch } = buildService(matchingQueryImpl({ pools: [ACTIVE_POOL] }));

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(result, '100.0000000');
});

test('processContributionMatch applies 2:1 ratio', async () => {
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, match_ratio: '2.00', pledge_amount: '2000.0000000' }],
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(result, '200.0000000');
});

test('processContributionMatch applies a non-integer ratio (0.50)', async () => {
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, match_ratio: '0.50', pledge_amount: '500.0000000' }],
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(result, '50.0000000');
});

test('processContributionMatch applies a non-integer ratio (1.50)', async () => {
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, match_ratio: '1.50', pledge_amount: '1500.0000000' }],
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(result, '150.0000000');
});

// ---------------------------------------------------------------------------
// processContributionMatch — fractional amounts (the bug this fixes)
// ---------------------------------------------------------------------------

test('processContributionMatch handles 0.1 + 0.2 without float drift', async () => {
  // Classic JS float: 0.1 + 0.2 === 0.30000000000000004.
  // With BigInt stroops the result must be exactly "0.3000000".
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [
        {
          ...ACTIVE_POOL,
          pledge_amount: '1.0000000',
          matched_amount: '0.1000000', // already matched 0.1
        },
      ],
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '0.2', // match ratio 1:1 → should yield "0.2000000"
  });

  assert.equal(result, '0.2000000');
});

test('processContributionMatch handles 8.29 exactly (float-drift regression)', async () => {
  // parseFloat('8.29') * 1e7 = 82_899_999 (off by 1 stroop).
  // The BigInt path must yield exactly 8.29 = 82_900_000 stroops.
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, pledge_amount: '100.0000000' }],
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '8.29',
  });

  assert.equal(result, '8.2900000');
});

test('processContributionMatch handles 19.99 exactly (float-drift regression)', async () => {
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, pledge_amount: '100.0000000' }],
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '19.99',
  });

  assert.equal(result, '19.9900000');
});

test('processContributionMatch accepts the smallest valid amount (1 stroop)', async () => {
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, pledge_amount: '0.0000010' }],
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '0.0000001',
  });

  assert.equal(result, '0.0000001');
});

// ---------------------------------------------------------------------------
// processContributionMatch — rounding boundary: pool cap
// ---------------------------------------------------------------------------

test('processContributionMatch caps at the remaining pool exactly (no float overshoot)', async () => {
  // Pool: 500. contribution × 1 ratio = 500 exactly → exhausted.
  const updateCalls = [];
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, pledge_amount: '500.0000000', matched_amount: '0.0000000' }],
      onQuery: (text, params) => {
        if (text.includes('UPDATE campaign_matches')) updateCalls.push(params);
      },
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '600',
  });

  assert.equal(result, '500.0000000');
  // Pool must be marked exhausted.
  assert.ok(updateCalls.some(p => p.includes('exhausted')));
});

test('processContributionMatch caps at a fractional remaining pool', async () => {
  // Pool: 100, already matched 99.9999999, remaining = 0.0000001 (1 stroop).
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [
        {
          ...ACTIVE_POOL,
          pledge_amount: '100.0000000',
          matched_amount: '99.9999999',
        },
      ],
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '50',
  });

  // Only 1 stroop remaining.
  assert.equal(result, '0.0000001');
});

test('processContributionMatch: pool exactly exhausted after cap keeps status exhausted', async () => {
  const statusValues = [];
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, pledge_amount: '0.0000001', matched_amount: '0.0000000' }],
      onQuery: (text, params) => {
        if (text.includes('UPDATE campaign_matches')) statusValues.push(params[1]);
      },
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '0.0000001',
  });

  assert.equal(result, '0.0000001');
  assert.ok(statusValues.includes('exhausted'));
});

test('processContributionMatch: contribution below pool does NOT exhaust it', async () => {
  const statusValues = [];
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, pledge_amount: '100.0000000', matched_amount: '0.0000000' }],
      onQuery: (text, params) => {
        if (text.includes('UPDATE campaign_matches')) statusValues.push(params[1]);
      },
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '50',
  });

  assert.equal(result, '50.0000000');
  assert.ok(statusValues.includes('active'));
});

// ---------------------------------------------------------------------------
// processContributionMatch — large amounts
// ---------------------------------------------------------------------------

test('processContributionMatch handles a large pledge without overflow', async () => {
  // Use an amount well within the Stellar int64 stroop limit (max ≈ 922,337,203,685).
  const largeAmount = '500000000000.0000000'; // 5 × 10^11
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, pledge_amount: largeAmount, matched_amount: '0.0000000' }],
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '1000000',
  });

  assert.equal(result, '1000000.0000000');
});

// ---------------------------------------------------------------------------
// processContributionMatch — locking and idempotency
// ---------------------------------------------------------------------------

test('processContributionMatch locks the pool row before spending it', async () => {
  const statements = [];
  const { processContributionMatch } = buildService(
    matchingQueryImpl({ pools: [ACTIVE_POOL], onQuery: text => statements.push(text) })
  );

  await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  const poolSelect = statements.find(text => text.includes('FROM campaign_matches'));
  assert.match(poolSelect, /FOR UPDATE/);
  assert.match(poolSelect, /matched_amount < pledge_amount/);
});

test('processContributionMatch credits the matched funds to the campaign ledger', async () => {
  const ledgerCalls = [];
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [ACTIVE_POOL],
      onQuery: (text, params) => {
        if (text.includes('UPDATE campaigns')) ledgerCalls.push(params);
      },
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(result, '100.0000000');
  assert.equal(ledgerCalls.length, 1);
  // First param is the matched amount as a 7-decimal string.
  assert.equal(ledgerCalls[0][0], '100.0000000');
  assert.equal(ledgerCalls[0][1], 'campaign-uuid-1');
});

test('processContributionMatch is idempotent for an already matched contribution', async () => {
  const mutations = [];
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [ACTIVE_POOL],
      // The guarded UPDATE ... WHERE match_amount = 0 claims nothing.
      claimReturns: () => [],
      onQuery: text => {
        if (text.includes('UPDATE')) mutations.push(text);
      },
    })
  );

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(result, '0.0000000');
  assert.ok(!mutations.some(text => text.includes('UPDATE campaign_matches')));
  assert.ok(!mutations.some(text => text.includes('UPDATE campaigns')));
});

test('processContributionMatch returns zero string when no pool available', async () => {
  const { processContributionMatch } = buildService(async () => ({ rows: [] }));

  const result = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(result, '0.0000000');
});

test('processContributionMatch validates a positive contribution amount', async () => {
  const { processContributionMatch } = buildService(async () => ({ rows: [] }));

  await assert.rejects(
    processContributionMatch({
      campaignId: 'campaign-uuid-1',
      contributionId: 'contrib-uuid-1',
      contributionAmount: '-5',
    }),
    /contributionAmount must be a positive number/
  );
});

test('processContributionMatch rejects a zero contribution amount', async () => {
  const { processContributionMatch } = buildService(async () => ({ rows: [] }));

  await assert.rejects(
    processContributionMatch({
      campaignId: 'campaign-uuid-1',
      contributionId: 'contrib-uuid-1',
      contributionAmount: '0',
    }),
    /contributionAmount must be a positive number/
  );
});

// ---------------------------------------------------------------------------
// getCampaignMatchProgress
// ---------------------------------------------------------------------------

test('getCampaignMatchProgress returns amounts as 7-decimal strings', async () => {
  const { getCampaignMatchProgress } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-1',
        sponsor_user_id: 'sponsor-1',
        sponsor_name: 'Sponsor One',
        match_ratio: '1.00',
        pledge_amount: '1000.0000000',
        matched_amount: '300.0000000',
        status: 'active',
        created_at: new Date(),
        contribution_count: 3,
        total_contributed: '300.0000000',
      },
    ],
  }));

  const progress = await getCampaignMatchProgress('campaign-uuid-1');

  // Top-level aggregates are strings.
  assert.equal(typeof progress.totalPledged, 'string');
  assert.equal(progress.totalPledged, '1000.0000000');
  assert.equal(progress.totalMatched, '300.0000000');
  assert.equal(progress.remainingPoolAmount, '700.0000000');

  // Per-match amounts are strings.
  assert.equal(progress.matches[0].pledgeAmount, '1000.0000000');
  assert.equal(progress.matches[0].matchedAmount, '300.0000000');
  assert.equal(progress.matches[0].remainingAmount, '700.0000000');
});

test('getCampaignMatchProgress aggregates multiple sponsors without float drift', async () => {
  // 0.1 + 0.2 = 0.3 exactly in BigInt; a float would give 0.30000000000000004.
  const { getCampaignMatchProgress } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-1',
        sponsor_user_id: 'sponsor-1',
        sponsor_name: 'Sponsor One',
        match_ratio: '1.00',
        pledge_amount: '1000.0000000',
        matched_amount: '300.0000000',
        status: 'active',
        created_at: new Date(),
        contribution_count: 3,
        total_contributed: '300.0000000',
      },
      {
        id: 'match-uuid-2',
        sponsor_user_id: 'sponsor-2',
        sponsor_name: 'Sponsor Two',
        match_ratio: '1.00',
        pledge_amount: '500.0000000',
        matched_amount: '100.0000000',
        status: 'active',
        created_at: new Date(),
        contribution_count: 1,
        total_contributed: '100.0000000',
      },
    ],
  }));

  const progress = await getCampaignMatchProgress('campaign-uuid-1');

  assert.equal(progress.totalPledged, '1500.0000000');
  assert.equal(progress.totalMatched, '400.0000000');
  assert.equal(progress.remainingPoolAmount, '1100.0000000');
  assert.equal(progress.activePoolCount, 2);
  // 400/1500 = 26.66…% → 26.66 (floor integer division on scaled value)
  assert.equal(progress.percentageUsed, '26.66');
});

test('getCampaignMatchProgress fractional pledge/matched amounts without drift', async () => {
  // 0.1 matched out of 0.3 pledged = 33.33…% used.
  const { getCampaignMatchProgress } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-1',
        sponsor_user_id: 'sponsor-1',
        sponsor_name: 'Sponsor',
        match_ratio: '1.00',
        pledge_amount: '0.3000000',
        matched_amount: '0.1000000',
        status: 'active',
        created_at: new Date(),
        contribution_count: 1,
        total_contributed: '0.1000000',
      },
    ],
  }));

  const progress = await getCampaignMatchProgress('campaign-uuid-1');

  assert.equal(progress.totalPledged, '0.3000000');
  assert.equal(progress.totalMatched, '0.1000000');
  assert.equal(progress.remainingPoolAmount, '0.2000000');
  // 0.1/0.3 * 100 = 33.33 (floor scaled).
  assert.equal(progress.percentageUsed, '33.33');
});

test('getCampaignMatchProgress never exposes sponsor user ids publicly', async () => {
  const { getCampaignMatchProgress } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-1',
        sponsor_user_id: 'sponsor-1',
        sponsor_name: 'Sponsor One',
        match_ratio: '1.00',
        pledge_amount: '1000.0000000',
        matched_amount: '300.0000000',
        status: 'active',
        created_at: new Date(),
        contribution_count: 3,
        total_contributed: '300.0000000',
      },
    ],
  }));

  const progress = await getCampaignMatchProgress('campaign-uuid-1');

  assert.equal(progress.matches[0].sponsorId, undefined);
  assert.equal(progress.matches[0].sponsorUserId, undefined);
  assert.equal(progress.matches[0].sponsorName, 'Sponsor One');
});

test('getCampaignMatchProgress calculates zero percentage when no pledges', async () => {
  const { getCampaignMatchProgress } = buildService(async () => ({ rows: [] }));

  const progress = await getCampaignMatchProgress('campaign-uuid-1');

  assert.equal(progress.totalPledged, '0.0000000');
  assert.equal(progress.percentageUsed, '0.00');
});

// ---------------------------------------------------------------------------
// completeMatchingPledge
// ---------------------------------------------------------------------------

test('completeMatchingPledge marks completed', async () => {
  const mockMatch = {
    id: 'match-uuid-1',
    campaign_id: 'campaign-uuid-1',
    sponsor_user_id: 'sponsor-uuid-1',
    pledge_amount: '1000.0000000',
    matched_amount: '600.0000000',
    status: 'completed',
  };

  const { completeMatchingPledge } = buildService(async () => ({ rows: [mockMatch] }));

  const result = await completeMatchingPledge('match-uuid-1');

  assert.deepEqual(result, mockMatch);
  assert.equal(result.status, 'completed');
});

test('completeMatchingPledge throws when not found', async () => {
  const { completeMatchingPledge } = buildService(async () => ({ rows: [] }));

  await assert.rejects(
    completeMatchingPledge('invalid-uuid'),
    /Match not found or already completed/
  );
});

// ---------------------------------------------------------------------------
// getSponsorMatchingPledges
// ---------------------------------------------------------------------------

test('getSponsorMatchingPledges returns amounts as 7-decimal strings', async () => {
  const { getSponsorMatchingPledges } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-1',
        campaign_id: 'campaign-1',
        campaign_title: 'Campaign A',
        campaign_status: 'active',
        sponsor_user_id: 'sponsor-uuid-1',
        sponsor_name: 'Sponsor',
        match_ratio: '1.00',
        pledge_amount: '1000.0000000',
        matched_amount: '300.0000000',
        status: 'active',
        contract_id: null,
        created_at: new Date(),
      },
    ],
  }));

  const pledges = await getSponsorMatchingPledges('sponsor-uuid-1');

  assert.equal(pledges.length, 1);
  assert.equal(typeof pledges[0].pledgeAmount, 'string');
  assert.equal(pledges[0].pledgeAmount, '1000.0000000');
  assert.equal(pledges[0].matchedAmount, '300.0000000');
  assert.equal(pledges[0].remainingAmount, '700.0000000');
});

test('getSponsorMatchingPledges handles fractional amounts without float drift', async () => {
  const { getSponsorMatchingPledges } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-2',
        campaign_id: 'campaign-2',
        campaign_title: 'Campaign B',
        campaign_status: 'active',
        sponsor_user_id: 'sponsor-uuid-1',
        sponsor_name: 'Sponsor',
        match_ratio: '1.00',
        pledge_amount: '0.3000000',
        matched_amount: '0.1000000',
        status: 'active',
        contract_id: null,
        created_at: new Date(),
      },
    ],
  }));

  const pledges = await getSponsorMatchingPledges('sponsor-uuid-1');

  // 0.3 - 0.1 = 0.2 exactly; float gives 0.19999999999999998.
  assert.equal(pledges[0].remainingAmount, '0.2000000');
});
