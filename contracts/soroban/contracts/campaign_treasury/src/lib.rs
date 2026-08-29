#![no_std]
//! Campaign treasury — a programmable alternative to CrowdPay's threshold-2 multisig
//! campaign wallet.
//!
//! The multisig wallet only enforces that two keys signed. This contract enforces
//! *rules*: a minimum hold period after the deadline, a ceiling on how much of the
//! balance may leave in one transaction, a cooldown between withdrawals, and an
//! auditor as a third signer above a configurable amount. Every executed withdrawal
//! is appended to on-chain history so the audit trail does not depend on the backend
//! database.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
    Vec,
};

/// Withdrawal history is capped so that `get_withdrawal_history` can never grow past
/// what fits in a single contract call's return value.
pub const MAX_HISTORY: u32 = 200;

/// Guards against a policy that would let one withdrawal drain everything by mistake.
pub const MAX_PCT: u32 = 100;

const SECONDS_PER_DAY: u64 = 86_400;
const SECONDS_PER_HOUR: u64 = 3_600;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TreasuryError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    /// The campaign deadline plus `min_hold_days` has not been reached yet.
    HoldPeriodNotElapsed = 3,
    /// The requested amount is a larger share of the balance than the policy allows.
    ExceedsMaxWithdrawalPct = 4,
    /// `withdrawal_cooldown_hours` has not elapsed since the last withdrawal.
    CooldownNotElapsed = 5,
    /// The treasury does not hold enough to cover the request.
    InsufficientBalance = 6,
    /// Withdrawals and contributions are paused by the platform.
    Paused = 7,
    /// No auditor was configured, but the policy requires one for this amount.
    AuditorNotConfigured = 8,
    /// No pending withdrawal exists with the given id.
    PendingNotFound = 9,
    /// A policy field is outside its permitted range.
    InvalidPolicy = 10,
    /// Auto-refund was requested but the policy has it switched off.
    AutoRefundDisabled = 11,
    /// Auto-refund was requested before the deadline, or the goal was met.
    RefundConditionsNotMet = 12,
    /// The amount is zero or negative.
    InvalidAmount = 13,
    /// The on-chain history is full; no further withdrawals can be recorded.
    HistoryFull = 14,
}

#[derive(Clone)]
#[contracttype]
pub struct TreasuryPolicy {
    /// Days after the campaign deadline before any withdrawal is permitted.
    pub min_hold_days: u32,
    /// Largest share of the current balance one withdrawal may take (1-100).
    pub max_single_withdrawal_pct: u32,
    /// Minimum hours between successive withdrawals.
    pub withdrawal_cooldown_hours: u32,
    /// Withdrawals strictly above this amount need the auditor as a third signer.
    pub require_auditor_for_above: i128,
    /// Return every contribution automatically if the goal is missed at deadline.
    pub auto_refund_on_miss: bool,
}

#[derive(Clone)]
#[contracttype]
pub struct WithdrawalRecord {
    pub id: u32,
    pub amount: i128,
    pub destination: Address,
    pub executed_at: u64,
    pub requester: Address,
    /// Set only when the withdrawal went through the auditor approval path.
    pub approved_by: Option<Address>,
}

#[derive(Clone)]
#[contracttype]
pub struct PendingWithdrawal {
    pub id: u32,
    pub amount: i128,
    pub destination: Address,
    pub memo: Symbol,
    pub requester: Address,
    pub created_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct ContributionRecord {
    pub contributor: Address,
    pub amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    CampaignId,
    Creator,
    Platform,
    Auditor,
    Policy,
    Deadline,
    Goal,
    Asset,
    TotalReceived,
    TotalWithdrawn,
    History,
    Pending,
    NextId,
    LastWithdrawalAt,
    Paused,
    Initialized,
    Refunded,
    /// Ordered contributor ledger, used to compute proportional refunds.
    Contributors,
}

#[contract]
pub struct CampaignTreasury;

#[contractimpl]
impl CampaignTreasury {
    /// Deploy-time configuration. Callable once.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        env: Env,
        campaign_id: Symbol,
        creator: Address,
        platform: Address,
        auditor: Option<Address>,
        policy: TreasuryPolicy,
        deadline: u64,
        goal: i128,
        asset: Address,
    ) -> Result<(), TreasuryError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(TreasuryError::AlreadyInitialized);
        }
        platform.require_auth();
        validate_policy(&policy)?;

        let storage = env.storage().instance();
        storage.set(&DataKey::CampaignId, &campaign_id);
        storage.set(&DataKey::Creator, &creator);
        storage.set(&DataKey::Platform, &platform);
        storage.set(&DataKey::Auditor, &auditor);
        storage.set(&DataKey::Policy, &policy);
        storage.set(&DataKey::Deadline, &deadline);
        storage.set(&DataKey::Goal, &goal);
        storage.set(&DataKey::Asset, &asset);
        storage.set(&DataKey::TotalReceived, &0i128);
        storage.set(&DataKey::TotalWithdrawn, &0i128);
        storage.set(&DataKey::NextId, &1u32);
        storage.set(&DataKey::LastWithdrawalAt, &0u64);
        storage.set(&DataKey::Paused, &false);
        storage.set(&DataKey::Refunded, &false);
        storage.set(&DataKey::Initialized, &true);
        env.storage()
            .persistent()
            .set(&DataKey::History, &Vec::<WithdrawalRecord>::new(&env));
        env.storage()
            .persistent()
            .set(&DataKey::Pending, &Vec::<PendingWithdrawal>::new(&env));
        env.storage()
            .persistent()
            .set(&DataKey::Contributors, &Vec::<ContributionRecord>::new(&env));

        env.events()
            .publish((symbol_short!("init"), campaign_id), creator);
        Ok(())
    }

    /// Records a confirmed contribution. Invoked by the platform's payment indexer
    /// after Horizon confirms the underlying payment.
    pub fn receive_contribution(
        env: Env,
        contributor: Address,
        amount: i128,
    ) -> Result<(), TreasuryError> {
        require_init(&env)?;
        require_not_paused(&env)?;
        if amount <= 0 {
            return Err(TreasuryError::InvalidAmount);
        }
        platform(&env).require_auth();

        let total: i128 = get_i128(&env, &DataKey::TotalReceived);
        env.storage()
            .instance()
            .set(&DataKey::TotalReceived, &(total + amount));

        // The contributor ledger is what makes a proportional refund possible; a
        // repeat contributor accumulates into their existing row.
        let mut contributors: Vec<ContributionRecord> = env
            .storage()
            .persistent()
            .get(&DataKey::Contributors)
            .unwrap_or_else(|| Vec::new(&env));
        let mut found = false;
        for i in 0..contributors.len() {
            let mut record = contributors.get(i).unwrap();
            if record.contributor == contributor {
                record.amount += amount;
                contributors.set(i, record);
                found = true;
                break;
            }
        }
        if !found {
            contributors.push_back(ContributionRecord {
                contributor: contributor.clone(),
                amount,
            });
        }
        env.storage()
            .persistent()
            .set(&DataKey::Contributors, &contributors);

        env.events()
            .publish((symbol_short!("received"), contributor), amount);
        Ok(())
    }

    /// Creator-initiated withdrawal. Enforces every policy constraint before moving
    /// any funds. Returns the pending id when auditor approval is required, or `None`
    /// when the transfer executed immediately.
    pub fn request_withdrawal(
        env: Env,
        amount: i128,
        destination: Address,
        memo: Symbol,
    ) -> Result<Option<u32>, TreasuryError> {
        require_init(&env)?;
        require_not_paused(&env)?;
        let creator = creator(&env);
        creator.require_auth();

        if amount <= 0 {
            return Err(TreasuryError::InvalidAmount);
        }

        let policy: TreasuryPolicy = env.storage().instance().get(&DataKey::Policy).unwrap();
        let now = env.ledger().timestamp();

        // 1. Hold period: deadline + min_hold_days must be behind us.
        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        let hold_until = deadline + (policy.min_hold_days as u64) * SECONDS_PER_DAY;
        if now < hold_until {
            return Err(TreasuryError::HoldPeriodNotElapsed);
        }

        // 2. Cooldown between successive withdrawals.
        let last: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LastWithdrawalAt)
            .unwrap_or(0);
        if last > 0 {
            let ready_at = last + (policy.withdrawal_cooldown_hours as u64) * SECONDS_PER_HOUR;
            if now < ready_at {
                return Err(TreasuryError::CooldownNotElapsed);
            }
        }

        // 3. The request must fit inside the balance and the per-withdrawal ceiling.
        let balance = available_balance(&env);
        if amount > balance {
            return Err(TreasuryError::InsufficientBalance);
        }
        // Compared against the balance at request time, so the cap tightens as the
        // treasury drains rather than being fixed at the original total.
        let ceiling = balance * (policy.max_single_withdrawal_pct as i128) / 100;
        if amount > ceiling {
            return Err(TreasuryError::ExceedsMaxWithdrawalPct);
        }

        // 4. Large withdrawals park as pending until the auditor signs.
        if amount > policy.require_auditor_for_above {
            if auditor(&env).is_none() {
                return Err(TreasuryError::AuditorNotConfigured);
            }
            let id = next_id(&env);
            let mut pending: Vec<PendingWithdrawal> = env
                .storage()
                .persistent()
                .get(&DataKey::Pending)
                .unwrap_or_else(|| Vec::new(&env));
            pending.push_back(PendingWithdrawal {
                id,
                amount,
                destination: destination.clone(),
                memo,
                requester: creator.clone(),
                created_at: now,
            });
            env.storage().persistent().set(&DataKey::Pending, &pending);
            env.events()
                .publish((symbol_short!("wpending"), destination), (id, amount));
            return Ok(Some(id));
        }

        let id = next_id(&env);
        execute(&env, id, amount, &destination, &creator, None)?;
        Ok(None)
    }

    /// Auditor sign-off that releases a withdrawal parked by `request_withdrawal`.
    pub fn approve_withdrawal(env: Env, pending_id: u32) -> Result<(), TreasuryError> {
        require_init(&env)?;
        require_not_paused(&env)?;
        let auditor = auditor(&env).ok_or(TreasuryError::AuditorNotConfigured)?;
        auditor.require_auth();

        let mut pending: Vec<PendingWithdrawal> = env
            .storage()
            .persistent()
            .get(&DataKey::Pending)
            .unwrap_or_else(|| Vec::new(&env));

        let mut found: Option<PendingWithdrawal> = None;
        for i in 0..pending.len() {
            let entry = pending.get(i).unwrap();
            if entry.id == pending_id {
                found = Some(entry);
                pending.remove(i);
                break;
            }
        }
        let entry = found.ok_or(TreasuryError::PendingNotFound)?;

        // Re-check the balance: time has passed since the request was parked.
        if entry.amount > available_balance(&env) {
            return Err(TreasuryError::InsufficientBalance);
        }
        env.storage().persistent().set(&DataKey::Pending, &pending);

        execute(
            &env,
            entry.id,
            entry.amount,
            &entry.destination,
            &entry.requester,
            Some(auditor),
        )
    }

    /// Returns every contribution proportionally when the goal was missed. Callable
    /// by anyone once the conditions hold, so refunds do not depend on the creator
    /// or the platform choosing to act.
    pub fn trigger_auto_refund(env: Env) -> Result<i128, TreasuryError> {
        require_init(&env)?;
        let policy: TreasuryPolicy = env.storage().instance().get(&DataKey::Policy).unwrap();
        if !policy.auto_refund_on_miss {
            return Err(TreasuryError::AutoRefundDisabled);
        }
        if env
            .storage()
            .instance()
            .get(&DataKey::Refunded)
            .unwrap_or(false)
        {
            return Err(TreasuryError::RefundConditionsNotMet);
        }

        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        let goal: i128 = env.storage().instance().get(&DataKey::Goal).unwrap();
        let received: i128 = get_i128(&env, &DataKey::TotalReceived);
        if env.ledger().timestamp() < deadline || received >= goal {
            return Err(TreasuryError::RefundConditionsNotMet);
        }

        let contributors: Vec<ContributionRecord> = env
            .storage()
            .persistent()
            .get(&DataKey::Contributors)
            .unwrap_or_else(|| Vec::new(&env));

        // Refunds are proportional to what is actually left, so a treasury that was
        // partially withdrawn before the miss still returns everything it holds
        // rather than reverting on the last contributor.
        let balance = available_balance(&env);
        let asset = asset(&env);
        let client = token::Client::new(&env, &asset);
        let contract = env.current_contract_address();

        let mut refunded: i128 = 0;
        for i in 0..contributors.len() {
            let record = contributors.get(i).unwrap();
            let share = if received > 0 {
                record.amount * balance / received
            } else {
                0
            };
            if share > 0 {
                client.transfer(&contract, &record.contributor, &share);
                refunded += share;
            }
        }

        env.storage().instance().set(&DataKey::Refunded, &true);
        env.events().publish(
            (symbol_short!("refunded"),),
            (refunded, contributors.len()),
        );
        Ok(refunded)
    }

    /// Platform circuit breaker. Blocks contributions and withdrawals while set.
    pub fn pause(env: Env, reason: Symbol) -> Result<(), TreasuryError> {
        require_init(&env)?;
        platform(&env).require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((symbol_short!("paused"),), reason);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), TreasuryError> {
        require_init(&env)?;
        platform(&env).require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((symbol_short!("unpaused"),), ());
        Ok(())
    }

    pub fn get_policy(env: Env) -> Result<TreasuryPolicy, TreasuryError> {
        require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::Policy).unwrap())
    }

    pub fn get_withdrawal_history(env: Env) -> Vec<WithdrawalRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::History)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn get_pending_withdrawals(env: Env) -> Vec<PendingWithdrawal> {
        env.storage()
            .persistent()
            .get(&DataKey::Pending)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn get_total_received(env: Env) -> i128 {
        get_i128(&env, &DataKey::TotalReceived)
    }

    pub fn get_total_withdrawn(env: Env) -> i128 {
        get_i128(&env, &DataKey::TotalWithdrawn)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }
}

// ── internals ────────────────────────────────────────────────────────────────

fn validate_policy(policy: &TreasuryPolicy) -> Result<(), TreasuryError> {
    if policy.max_single_withdrawal_pct == 0 || policy.max_single_withdrawal_pct > MAX_PCT {
        return Err(TreasuryError::InvalidPolicy);
    }
    if policy.require_auditor_for_above < 0 {
        return Err(TreasuryError::InvalidPolicy);
    }
    Ok(())
}

fn require_init(env: &Env) -> Result<(), TreasuryError> {
    if env.storage().instance().has(&DataKey::Initialized) {
        Ok(())
    } else {
        Err(TreasuryError::NotInitialized)
    }
}

fn require_not_paused(env: &Env) -> Result<(), TreasuryError> {
    if env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
    {
        Err(TreasuryError::Paused)
    } else {
        Ok(())
    }
}

fn creator(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Creator).unwrap()
}

fn platform(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Platform).unwrap()
}

fn auditor(env: &Env) -> Option<Address> {
    env.storage()
        .instance()
        .get(&DataKey::Auditor)
        .unwrap_or(None)
}

fn asset(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Asset).unwrap()
}

fn get_i128(env: &Env, key: &DataKey) -> i128 {
    env.storage().instance().get(key).unwrap_or(0)
}

fn next_id(env: &Env) -> u32 {
    let id: u32 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
    env.storage().instance().set(&DataKey::NextId, &(id + 1));
    id
}

/// What the treasury may still pay out: everything received less everything already
/// withdrawn. Reading the ledger balance directly would let a stray inbound payment
/// widen the percentage ceiling.
fn available_balance(env: &Env) -> i128 {
    get_i128(env, &DataKey::TotalReceived) - get_i128(env, &DataKey::TotalWithdrawn)
}

fn execute(
    env: &Env,
    id: u32,
    amount: i128,
    destination: &Address,
    requester: &Address,
    approved_by: Option<Address>,
) -> Result<(), TreasuryError> {
    let mut history: Vec<WithdrawalRecord> = env
        .storage()
        .persistent()
        .get(&DataKey::History)
        .unwrap_or_else(|| Vec::new(env));
    if history.len() >= MAX_HISTORY {
        return Err(TreasuryError::HistoryFull);
    }

    let asset = asset(env);
    token::Client::new(env, &asset).transfer(
        &env.current_contract_address(),
        destination,
        &amount,
    );

    let now = env.ledger().timestamp();
    let withdrawn: i128 = get_i128(env, &DataKey::TotalWithdrawn);
    env.storage()
        .instance()
        .set(&DataKey::TotalWithdrawn, &(withdrawn + amount));
    env.storage().instance().set(&DataKey::LastWithdrawalAt, &now);

    history.push_back(WithdrawalRecord {
        id,
        amount,
        destination: destination.clone(),
        executed_at: now,
        requester: requester.clone(),
        approved_by,
    });
    env.storage().persistent().set(&DataKey::History, &history);

    env.events()
        .publish((symbol_short!("withdrawn"), destination.clone()), (id, amount));
    Ok(())
}

mod test;
