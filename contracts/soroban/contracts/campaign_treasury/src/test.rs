#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{symbol_short, token, Address, Env};

const DAY: u64 = 86_400;
const HOUR: u64 = 3_600;
const DEADLINE: u64 = 1_000_000;

struct Harness {
    creator: Address,
    platform: Address,
    auditor: Address,
    token: token::Client<'static>,
    client: CampaignTreasuryClient<'static>,
    contract_id: Address,
}

fn policy() -> TreasuryPolicy {
    TreasuryPolicy {
        min_hold_days: 0,
        max_single_withdrawal_pct: 100,
        withdrawal_cooldown_hours: 0,
        require_auditor_for_above: i128::MAX,
        auto_refund_on_miss: false,
    }
}

fn setup(env: &Env, policy: TreasuryPolicy, goal: i128) -> Harness {
    env.mock_all_auths();
    env.ledger().set_timestamp(DEADLINE);

    let creator = Address::generate(env);
    let platform = Address::generate(env);
    let auditor = Address::generate(env);
    let token_admin = Address::generate(env);

    let token_id = env.register_stellar_asset_contract(token_admin.clone());
    let token = token::Client::new(env, &token_id);
    let token_admin_client = token::StellarAssetClient::new(env, &token_id);

    let contract_id = env.register_contract(None, CampaignTreasury);
    let client = CampaignTreasuryClient::new(env, &contract_id);

    client.initialize(
        &symbol_short!("cp687"),
        &creator,
        &platform,
        &Some(auditor.clone()),
        &policy,
        &DEADLINE,
        &goal,
        &token_id,
    );

    // Fund the treasury so transfers out have something to move.
    token_admin_client.mint(&contract_id, &1_000_000);

    Harness {
        creator,
        platform,
        auditor,
        token,
        client,
        contract_id,
    }
}

/// Books `amount` as received from a fresh contributor.
fn contribute(env: &Env, h: &Harness, amount: i128) -> Address {
    let contributor = Address::generate(env);
    h.client.receive_contribution(&contributor, &amount);
    contributor
}

#[test]
fn initializes_and_exposes_policy() {
    let env = Env::default();
    let h = setup(&env, policy(), 10_000);

    let stored = h.client.get_policy();
    assert_eq!(stored.max_single_withdrawal_pct, 100);
    assert_eq!(h.client.get_total_received(), 0);
    assert_eq!(h.client.get_total_withdrawn(), 0);
    assert!(!h.client.is_paused());
    assert_eq!(h.client.get_withdrawal_history().len(), 0);
}

#[test]
fn rejects_double_initialization() {
    let env = Env::default();
    let h = setup(&env, policy(), 10_000);
    let err = h
        .client
        .try_initialize(
            &symbol_short!("cp687"),
            &h.creator,
            &h.platform,
            &Some(h.auditor.clone()),
            &policy(),
            &DEADLINE,
            &10_000,
            &h.token.address,
        )
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, TreasuryError::AlreadyInitialized);
}

#[test]
fn rejects_a_policy_with_an_out_of_range_percentage() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, CampaignTreasury);
    let client = CampaignTreasuryClient::new(&env, &contract_id);
    let asset = env.register_stellar_asset_contract(Address::generate(&env));

    let mut bad = policy();
    bad.max_single_withdrawal_pct = 101;

    let err = client
        .try_initialize(
            &symbol_short!("cp687"),
            &Address::generate(&env),
            &Address::generate(&env),
            &None,
            &bad,
            &DEADLINE,
            &10_000,
            &asset,
        )
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, TreasuryError::InvalidPolicy);
}

// ── acceptance criterion 1: min_hold_days ────────────────────────────────────

#[test]
fn withdrawal_before_the_hold_period_is_rejected_and_moves_no_funds() {
    let env = Env::default();
    let mut p = policy();
    p.min_hold_days = 30;
    let h = setup(&env, p, 10_000);
    contribute(&env, &h, 10_000);

    let destination = Address::generate(&env);
    let before = h.token.balance(&h.contract_id);

    // 29 days after the deadline — one day short.
    env.ledger().set_timestamp(DEADLINE + 29 * DAY);
    let err = h
        .client
        .try_request_withdrawal(&1_000, &destination, &symbol_short!("w1"))
        .err()
        .unwrap()
        .unwrap();

    assert_eq!(err, TreasuryError::HoldPeriodNotElapsed);
    // No transfer happened and nothing was recorded.
    assert_eq!(h.token.balance(&h.contract_id), before);
    assert_eq!(h.token.balance(&destination), 0);
    assert_eq!(h.client.get_withdrawal_history().len(), 0);
    assert_eq!(h.client.get_total_withdrawn(), 0);

    // One day later the same request goes through.
    env.ledger().set_timestamp(DEADLINE + 30 * DAY);
    h.client
        .request_withdrawal(&1_000, &destination, &symbol_short!("w1"));
    assert_eq!(h.token.balance(&destination), 1_000);
}

// ── acceptance criterion 4: max_single_withdrawal_pct ────────────────────────

#[test]
fn twenty_five_percent_cap_rejects_three_thousand_of_ten_thousand() {
    let env = Env::default();
    let mut p = policy();
    p.max_single_withdrawal_pct = 25;
    let h = setup(&env, p, 10_000);
    contribute(&env, &h, 10_000);

    let destination = Address::generate(&env);
    let err = h
        .client
        .try_request_withdrawal(&3_000, &destination, &symbol_short!("w1"))
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, TreasuryError::ExceedsMaxWithdrawalPct);

    // 2,500 is exactly 25% and is allowed.
    h.client
        .request_withdrawal(&2_500, &destination, &symbol_short!("w1"));
    assert_eq!(h.token.balance(&destination), 2_500);
}

#[test]
fn the_percentage_ceiling_tracks_the_remaining_balance() {
    let env = Env::default();
    let mut p = policy();
    p.max_single_withdrawal_pct = 50;
    let h = setup(&env, p, 10_000);
    contribute(&env, &h, 10_000);

    let destination = Address::generate(&env);
    h.client
        .request_withdrawal(&5_000, &destination, &symbol_short!("w1"));

    // 5,000 remains, so the ceiling is now 2,500 rather than the original 5,000.
    let err = h
        .client
        .try_request_withdrawal(&5_000, &destination, &symbol_short!("w2"))
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, TreasuryError::ExceedsMaxWithdrawalPct);

    h.client
        .request_withdrawal(&2_500, &destination, &symbol_short!("w2"));
    assert_eq!(h.client.get_total_withdrawn(), 7_500);
}

#[test]
fn cooldown_blocks_a_second_withdrawal_until_it_elapses() {
    let env = Env::default();
    let mut p = policy();
    p.withdrawal_cooldown_hours = 24;
    p.max_single_withdrawal_pct = 50;
    let h = setup(&env, p, 10_000);
    contribute(&env, &h, 10_000);

    let destination = Address::generate(&env);
    h.client
        .request_withdrawal(&1_000, &destination, &symbol_short!("w1"));

    env.ledger().set_timestamp(DEADLINE + 23 * HOUR);
    let err = h
        .client
        .try_request_withdrawal(&1_000, &destination, &symbol_short!("w2"))
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, TreasuryError::CooldownNotElapsed);

    env.ledger().set_timestamp(DEADLINE + 24 * HOUR);
    h.client
        .request_withdrawal(&1_000, &destination, &symbol_short!("w2"));
    assert_eq!(h.client.get_total_withdrawn(), 2_000);
}

// ── acceptance criterion 2: auditor threshold ────────────────────────────────

#[test]
fn a_withdrawal_above_the_auditor_threshold_parks_until_approved() {
    let env = Env::default();
    let mut p = policy();
    p.require_auditor_for_above = 1_000;
    let h = setup(&env, p, 10_000);
    contribute(&env, &h, 10_000);

    let destination = Address::generate(&env);
    let pending_id = h
        .client
        .request_withdrawal(&5_000, &destination, &symbol_short!("big"))
        .unwrap();

    // Nothing moved: the request is parked, not executed.
    assert_eq!(h.token.balance(&destination), 0);
    assert_eq!(h.client.get_total_withdrawn(), 0);
    assert_eq!(h.client.get_withdrawal_history().len(), 0);
    assert_eq!(h.client.get_pending_withdrawals().len(), 1);

    h.client.approve_withdrawal(&pending_id);

    assert_eq!(h.token.balance(&destination), 5_000);
    assert_eq!(h.client.get_total_withdrawn(), 5_000);
    assert_eq!(h.client.get_pending_withdrawals().len(), 0);

    let history = h.client.get_withdrawal_history();
    assert_eq!(history.len(), 1);
    let record = history.get(0).unwrap();
    assert_eq!(record.amount, 5_000);
    assert_eq!(record.approved_by, Some(h.auditor.clone()));
    assert_eq!(record.requester, h.creator);
}

#[test]
fn at_or_below_the_auditor_threshold_executes_immediately() {
    let env = Env::default();
    let mut p = policy();
    p.require_auditor_for_above = 1_000;
    let h = setup(&env, p, 10_000);
    contribute(&env, &h, 10_000);

    let destination = Address::generate(&env);
    // Exactly the threshold is not "above" it.
    let pending = h
        .client
        .request_withdrawal(&1_000, &destination, &symbol_short!("ok"));
    assert_eq!(pending, None);
    assert_eq!(h.token.balance(&destination), 1_000);

    let record = h.client.get_withdrawal_history().get(0).unwrap();
    assert_eq!(record.approved_by, None);
}

#[test]
fn approving_an_unknown_pending_id_is_rejected() {
    let env = Env::default();
    let h = setup(&env, policy(), 10_000);
    let err = h.client.try_approve_withdrawal(&404).err().unwrap().unwrap();
    assert_eq!(err, TreasuryError::PendingNotFound);
}

#[test]
fn the_auditor_threshold_requires_a_configured_auditor() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(DEADLINE);

    let creator = Address::generate(&env);
    let platform = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin);
    let contract_id = env.register_contract(None, CampaignTreasury);
    let client = CampaignTreasuryClient::new(&env, &contract_id);

    let mut p = policy();
    p.require_auditor_for_above = 1_000;
    client.initialize(
        &symbol_short!("cp687"),
        &creator,
        &platform,
        &None,
        &p,
        &DEADLINE,
        &10_000,
        &token_id,
    );
    let contributor = Address::generate(&env);
    client.receive_contribution(&contributor, &10_000);

    let err = client
        .try_request_withdrawal(&5_000, &Address::generate(&env), &symbol_short!("big"))
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, TreasuryError::AuditorNotConfigured);
}

// ── acceptance criterion 3: auto refund ──────────────────────────────────────

#[test]
fn auto_refund_returns_each_contributor_their_proportional_share() {
    let env = Env::default();
    let mut p = policy();
    p.auto_refund_on_miss = true;
    let h = setup(&env, p, 10_000);

    // 6,000 raised against a 10,000 goal — the campaign missed.
    let a = contribute(&env, &h, 3_000);
    let b = contribute(&env, &h, 2_000);
    let c = contribute(&env, &h, 1_000);

    env.ledger().set_timestamp(DEADLINE + 1);
    let refunded = h.client.trigger_auto_refund();

    assert_eq!(refunded, 6_000);
    assert_eq!(h.token.balance(&a), 3_000);
    assert_eq!(h.token.balance(&b), 2_000);
    assert_eq!(h.token.balance(&c), 1_000);

    // Refunding twice is refused.
    let err = h.client.try_trigger_auto_refund().err().unwrap().unwrap();
    assert_eq!(err, TreasuryError::RefundConditionsNotMet);
}

#[test]
fn auto_refund_accumulates_repeat_contributors_into_one_payment() {
    let env = Env::default();
    let mut p = policy();
    p.auto_refund_on_miss = true;
    let h = setup(&env, p, 10_000);

    let repeat = Address::generate(&env);
    h.client.receive_contribution(&repeat, &1_000);
    h.client.receive_contribution(&repeat, &500);
    let other = contribute(&env, &h, 500);

    env.ledger().set_timestamp(DEADLINE + 1);
    let refunded = h.client.trigger_auto_refund();

    assert_eq!(refunded, 2_000);
    assert_eq!(h.token.balance(&repeat), 1_500);
    assert_eq!(h.token.balance(&other), 500);
}

#[test]
fn auto_refund_is_refused_before_the_deadline_or_when_the_goal_was_met() {
    let env = Env::default();
    let mut p = policy();
    p.auto_refund_on_miss = true;
    let h = setup(&env, p, 10_000);
    contribute(&env, &h, 4_000);

    // Deadline not reached yet.
    env.ledger().set_timestamp(DEADLINE - 1);
    assert_eq!(
        h.client.try_trigger_auto_refund().err().unwrap().unwrap(),
        TreasuryError::RefundConditionsNotMet
    );

    // Goal met, so a refund is not warranted even after the deadline.
    contribute(&env, &h, 6_000);
    env.ledger().set_timestamp(DEADLINE + 1);
    assert_eq!(
        h.client.try_trigger_auto_refund().err().unwrap().unwrap(),
        TreasuryError::RefundConditionsNotMet
    );
}

#[test]
fn auto_refund_is_refused_when_the_policy_disables_it() {
    let env = Env::default();
    let h = setup(&env, policy(), 10_000); // auto_refund_on_miss = false
    contribute(&env, &h, 1_000);

    env.ledger().set_timestamp(DEADLINE + 1);
    assert_eq!(
        h.client.try_trigger_auto_refund().err().unwrap().unwrap(),
        TreasuryError::AutoRefundDisabled
    );
}

// ── pause ────────────────────────────────────────────────────────────────────

#[test]
fn pausing_blocks_contributions_and_withdrawals_until_unpaused() {
    let env = Env::default();
    let h = setup(&env, policy(), 10_000);
    contribute(&env, &h, 10_000);

    h.client.pause(&symbol_short!("fraud"));
    assert!(h.client.is_paused());

    let destination = Address::generate(&env);
    assert_eq!(
        h.client
            .try_request_withdrawal(&100, &destination, &symbol_short!("w1"))
            .err()
            .unwrap()
            .unwrap(),
        TreasuryError::Paused
    );
    let contributor = Address::generate(&env);
    assert_eq!(
        h.client
            .try_receive_contribution(&contributor, &100)
            .err()
            .unwrap()
            .unwrap(),
        TreasuryError::Paused
    );

    h.client.unpause();
    assert!(!h.client.is_paused());
    h.client
        .request_withdrawal(&100, &destination, &symbol_short!("w1"));
    assert_eq!(h.token.balance(&destination), 100);
}

// ── balances and history ─────────────────────────────────────────────────────

#[test]
fn a_withdrawal_larger_than_the_balance_is_refused() {
    let env = Env::default();
    let h = setup(&env, policy(), 10_000);
    contribute(&env, &h, 1_000);

    let err = h
        .client
        .try_request_withdrawal(&2_000, &Address::generate(&env), &symbol_short!("w1"))
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, TreasuryError::InsufficientBalance);
}

#[test]
fn zero_and_negative_amounts_are_refused() {
    let env = Env::default();
    let h = setup(&env, policy(), 10_000);
    contribute(&env, &h, 1_000);
    let destination = Address::generate(&env);

    assert_eq!(
        h.client
            .try_request_withdrawal(&0, &destination, &symbol_short!("z"))
            .err()
            .unwrap()
            .unwrap(),
        TreasuryError::InvalidAmount
    );
    assert_eq!(
        h.client
            .try_request_withdrawal(&-5, &destination, &symbol_short!("n"))
            .err()
            .unwrap()
            .unwrap(),
        TreasuryError::InvalidAmount
    );
}

// ── acceptance criterion 6: history stays consistent across many operations ──

#[test]
fn fifty_withdrawals_are_all_recorded_in_order_with_matching_totals() {
    let env = Env::default();
    let mut p = policy();
    p.max_single_withdrawal_pct = 100;
    let h = setup(&env, p, 100_000);
    contribute(&env, &h, 100_000);

    let destination = Address::generate(&env);
    for i in 0..50u32 {
        env.ledger().set_timestamp(DEADLINE + (i as u64) * HOUR);
        h.client
            .request_withdrawal(&100, &destination, &symbol_short!("w"));
    }

    let history = h.client.get_withdrawal_history();
    assert_eq!(history.len(), 50);
    assert_eq!(h.client.get_total_withdrawn(), 5_000);
    assert_eq!(h.token.balance(&destination), 5_000);

    // Ids are unique, strictly increasing, and every row carries the real amount —
    // this is what the backend reconciles withdrawal_requests against.
    let mut previous = 0u32;
    let mut summed = 0i128;
    for i in 0..history.len() {
        let record = history.get(i).unwrap();
        assert!(record.id > previous, "ids must strictly increase");
        previous = record.id;
        assert_eq!(record.amount, 100);
        assert_eq!(record.destination, destination);
        assert_eq!(record.requester, h.creator);
        summed += record.amount;
    }
    assert_eq!(summed, h.client.get_total_withdrawn());
}

#[test]
fn uninitialized_calls_are_refused() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, CampaignTreasury);
    let client = CampaignTreasuryClient::new(&env, &contract_id);

    assert_eq!(
        client.try_get_policy().err().unwrap().unwrap(),
        TreasuryError::NotInitialized
    );
    assert_eq!(
        client
            .try_request_withdrawal(&1, &Address::generate(&env), &symbol_short!("w"))
            .err()
            .unwrap()
            .unwrap(),
        TreasuryError::NotInitialized
    );
}

#[test]
fn test_initialize_requires_platform_auth() {
    let env = Env::default();
    let contract_id = env.register_contract(None, CampaignTreasury);
    let client = CampaignTreasuryClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let platform = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(
            &symbol_short!("cp687"),
            &creator,
            &platform,
            &None,
            &policy(),
            &DEADLINE,
            &10_000,
            &token_id,
        );
    }));
    assert!(result.is_err());
}
