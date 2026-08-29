#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

/// Maximum platform fee the contract will ever accept, in basis points (10% = 1000 BPS).
///
/// This guards against configuration typos (e.g. `1000` instead of `100`, or `10000`
/// instead of `100`) that would otherwise route an unreasonable share — or all — of a
/// campaign's funds to the platform. Any fee above this cap is rejected outright.
pub const MAX_FEE_BPS: u32 = 1000;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    CampaignId,
    Target,
    Deadline,
    Asset,
    Balances(Address),
    TotalRaised,
    ApprovedWithdrawal,
    ApprovedWithdrawalFor(Address),
    IsInitialized,
    PlatformFeeBps,
    PlatformFeeRecipient,
    PendingFeeBps,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        campaign_id: u64,
        target: i128,
        deadline: u64,
        asset: Address,
        platform_fee_bps: u32,
        platform_fee_recipient: Address,
    ) {
        if env.storage().instance().has(&DataKey::IsInitialized) {
            panic!("Contract is already initialized");
        }
        platform_fee_recipient.require_auth();

        if target <= 0 {
            panic!("Target must be positive");
        }
        if platform_fee_bps > MAX_FEE_BPS {
            panic!("Platform fee BPS must not exceed MAX_FEE_BPS");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::CampaignId, &campaign_id);
        env.storage().instance().set(&DataKey::Target, &target);
        env.storage().instance().set(&DataKey::Deadline, &deadline);
        env.storage().instance().set(&DataKey::Asset, &asset);
        env.storage().instance().set(&DataKey::TotalRaised, &0i128);
        env.storage().instance().set(&DataKey::ApprovedWithdrawal, &0i128);
        env.storage().instance().set(&DataKey::IsInitialized, &true);
        env.storage().instance().set(&DataKey::PlatformFeeBps, &platform_fee_bps);
        env.storage().instance().set(&DataKey::PlatformFeeRecipient, &platform_fee_recipient);
    }

    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();

        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        let current_time = env.ledger().timestamp();
        if current_time > deadline {
            panic!("Campaign deadline has passed");
        }

        let asset: Address = env.storage().instance().get(&DataKey::Asset).unwrap();
        let client = token::Client::new(&env, &asset);
        client.transfer(&from, &env.current_contract_address(), &amount);

        let balance_key = DataKey::Balances(from.clone());
        let current_balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        env.storage().persistent().set(&balance_key, &(current_balance + amount));

        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalRaised, &(total_raised + amount));

        env.events().publish(
            (Symbol::new(&env, "deposit"), from),
            amount,
        );
    }

    pub fn approve_withdrawal(env: Env, to: Address, release_amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if release_amount <= 0 {
            panic!("Release amount must be positive");
        }

        let dest_key = DataKey::ApprovedWithdrawalFor(to.clone());
        let approved_for_to: i128 = env.storage().persistent().get(&dest_key).unwrap_or(0);
        env.storage().persistent().set(&dest_key, &(approved_for_to + release_amount));

        let approved: i128 = env.storage().instance().get(&DataKey::ApprovedWithdrawal).unwrap_or(0);
        env.storage().instance().set(&DataKey::ApprovedWithdrawal, &(approved + release_amount));

        env.events().publish(
            (Symbol::new(&env, "approve_withdrawal"), to),
            release_amount,
        );
    }

    /// Step 1 of 2: the admin proposes a new platform fee.
    ///
    /// The proposal is validated against [`MAX_FEE_BPS`] and stored as pending, but it
    /// does **not** take effect until [`Self::confirm_fee_change`] is called in a separate
    /// transaction. Requiring two explicit admin actions makes an accidental, fund-draining
    /// fee change far harder to trigger by a single typo.
    pub fn propose_fee_change(env: Env, new_fee_bps: u32) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if new_fee_bps > MAX_FEE_BPS {
            panic!("Platform fee BPS must not exceed MAX_FEE_BPS");
        }

        env.storage().instance().set(&DataKey::PendingFeeBps, &new_fee_bps);

        env.events().publish(
            (Symbol::new(&env, "fee_proposed"), admin),
            new_fee_bps,
        );
    }

    /// Step 2 of 2: the admin confirms the pending fee, applying it.
    ///
    /// Panics if there is no pending proposal. The pending value is re-validated against
    /// [`MAX_FEE_BPS`] as a defense-in-depth measure before it becomes the active fee.
    pub fn confirm_fee_change(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let new_fee_bps: u32 = match env.storage().instance().get(&DataKey::PendingFeeBps) {
            Some(bps) => bps,
            None => panic!("No pending fee change to confirm"),
        };

        if new_fee_bps > MAX_FEE_BPS {
            panic!("Platform fee BPS must not exceed MAX_FEE_BPS");
        }

        env.storage().instance().set(&DataKey::PlatformFeeBps, &new_fee_bps);
        env.storage().instance().remove(&DataKey::PendingFeeBps);

        env.events().publish(
            (Symbol::new(&env, "fee_changed"), admin),
            new_fee_bps,
        );
    }

    /// Cancels any pending fee proposal without applying it.
    pub fn cancel_fee_change(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if !env.storage().instance().has(&DataKey::PendingFeeBps) {
            panic!("No pending fee change to cancel");
        }

        env.storage().instance().remove(&DataKey::PendingFeeBps);

        env.events().publish(
            (Symbol::new(&env, "fee_cancelled"), admin),
            (),
        );
    }

    /// Returns the pending proposed fee in BPS, or `None` if no change is pending.
    pub fn get_pending_fee(env: Env) -> Option<u32> {
        env.storage().instance().get(&DataKey::PendingFeeBps)
    }

    pub fn execute_withdrawal(env: Env, to: Address, release_amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if release_amount <= 0 {
            panic!("Release amount must be positive");
        }

        let dest_key = DataKey::ApprovedWithdrawalFor(to.clone());
        let mut approved_for_to: i128 = env.storage().persistent().get(&dest_key).unwrap_or(0);
        if approved_for_to < release_amount {
            panic!("Insufficient approved amount for destination");
        }

        let mut approved: i128 = env.storage().instance().get(&DataKey::ApprovedWithdrawal).unwrap_or(0);
        if approved < release_amount {
            panic!("Insufficient approved amount");
        }

        let asset: Address = env.storage().instance().get(&DataKey::Asset).unwrap();
        let client = token::Client::new(&env, &asset);

        let fee_bps: u32 = env.storage().instance().get(&DataKey::PlatformFeeBps).unwrap_or(0);
        let fee_amount = (release_amount * (fee_bps as i128)) / 10000;
        let net_amount = release_amount - fee_amount;

        if net_amount > 0 {
            client.transfer(&env.current_contract_address(), &to, &net_amount);
        }

        if fee_amount > 0 {
            let fee_recipient: Address = env.storage().instance().get(&DataKey::PlatformFeeRecipient).unwrap();
            client.transfer(&env.current_contract_address(), &fee_recipient, &fee_amount);
        }

        approved_for_to -= release_amount;
        env.storage().persistent().set(&dest_key, &approved_for_to);

        approved -= release_amount;
        env.storage().instance().set(&DataKey::ApprovedWithdrawal, &approved);

        env.events().publish(
            (Symbol::new(&env, "withdrawal"), to),
            (release_amount, net_amount, fee_amount),
        );
    }

    pub fn refund(env: Env, contributor: Address) {
        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        if env.ledger().timestamp() < deadline {
            panic!("Deadline has not passed");
        }

        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        let target: i128 = env.storage().instance().get(&DataKey::Target).unwrap();

        if total_raised >= target {
            panic!("Campaign succeeded, refunds unavailable");
        }

        let balance_key = DataKey::Balances(contributor.clone());
        let amount: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        if amount <= 0 {
            panic!("No contribution to refund");
        }

        let asset: Address = env.storage().instance().get(&DataKey::Asset).unwrap();
        let client = token::Client::new(&env, &asset);
        client.transfer(&env.current_contract_address(), &contributor, &amount);

        env.storage().persistent().set(&balance_key, &0i128);

        let total_raised_current: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        let new_total = total_raised_current - amount;
        env.storage().instance().set(&DataKey::TotalRaised, &new_total);

        env.events().publish(
            (Symbol::new(&env, "refund"), contributor),
            amount,
        );
    }

    pub fn get_total_raised(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0)
    }

    pub fn get_asset(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Asset).unwrap()
    }

    pub fn get_platform_fee_config(env: Env) -> (u32, Address) {
        let bps: u32 = env.storage().instance().get(&DataKey::PlatformFeeBps).unwrap_or(0);
        let recipient: Address = env.storage().instance().get(&DataKey::PlatformFeeRecipient).unwrap();
        (bps, recipient)
    }

    pub fn get_approved_withdrawal(env: Env, to: Address) -> i128 {
        let dest_key = DataKey::ApprovedWithdrawalFor(to);
        env.storage().persistent().get(&dest_key).unwrap_or(0)
    }
}
