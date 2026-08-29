#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec, token
};

#[cfg(test)]
mod test;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub target: i128,
    pub amount: i128,
    pub released: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    CampaignId,
    Goal,
    Deadline,
    Creator,
    Token,
    TotalRaised,
    TotalReleased,
    Contributions(Address),
    Milestones,
    Status,
}

#[contract]
pub struct CrowdPayContract;

#[contractimpl]
impl CrowdPayContract {
    pub fn initialize(
        env: Env,
        campaign_id: Symbol,
        creator: Address,
        token: Address,
        goal: i128,
        deadline: u64,
        milestones: Vec<Milestone>,
    ) {
        if env.storage().instance().has(&DataKey::CampaignId) {
            panic!("Already initialized");
        }
        creator.require_auth();

        if goal <= 0 {
            panic!("Goal must be positive");
        }
        if milestones.is_empty() {
            panic!("Milestones cannot be empty");
        }

        let mut total_milestone_amount: i128 = 0;
        for m in milestones.iter() {
            if m.target <= 0 {
                panic!("Milestone target must be positive");
            }
            if m.amount <= 0 {
                panic!("Milestone amount must be positive");
            }
            total_milestone_amount += m.amount;
        }

        if total_milestone_amount > goal {
            panic!("Total milestone allocations cannot exceed goal");
        }

        env.storage().instance().set(&DataKey::CampaignId, &campaign_id);
        env.storage().instance().set(&DataKey::Creator, &creator);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Goal, &goal);
        env.storage().instance().set(&DataKey::Deadline, &deadline);
        env.storage().instance().set(&DataKey::Milestones, &milestones);
        env.storage().instance().set(&DataKey::TotalRaised, &0i128);
        env.storage().instance().set(&DataKey::TotalReleased, &0i128);
        env.storage().instance().set(&DataKey::Status, &symbol_short!("Active"));
    }

    pub fn contribute(env: Env, contributor: Address, amount: i128) {
        contributor.require_auth();
        
        let status: Symbol = env.storage().instance().get(&DataKey::Status).unwrap();
        if status != symbol_short!("Active") && status != symbol_short!("Funded") {
            panic!("Campaign is not accepting contributions");
        }

        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        if env.ledger().timestamp() >= deadline {
            panic!("Deadline passed");
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&contributor, &env.current_contract_address(), &amount);

        let balance_key = DataKey::Contributions(contributor.clone());
        let current_balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        env.storage().persistent().set(&balance_key, &(current_balance + amount));

        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        let new_total = total_raised + amount;
        env.storage().instance().set(&DataKey::TotalRaised, &new_total);

        // Check if goal reached
        let goal: i128 = env.storage().instance().get(&DataKey::Goal).unwrap();
        if new_total >= goal && status == symbol_short!("Active") {
            env.storage().instance().set(&DataKey::Status, &symbol_short!("Funded"));
        }
    }

    pub fn release_milestone(env: Env, milestone_index: u32) {
        let creator: Address = env.storage().instance().get(&DataKey::Creator).unwrap();
        creator.require_auth();

        let mut milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).unwrap();
        let mut milestone = milestones.get(milestone_index).expect("Invalid milestone index");

        if milestone.released {
            panic!("Milestone already released");
        }

        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        if total_raised < milestone.target {
            panic!("Milestone target not met");
        }

        let total_released: i128 = env.storage().instance().get(&DataKey::TotalReleased).unwrap_or(0);
        let milestone_amount = milestone.amount;

        if total_released + milestone_amount > total_raised {
            panic!("Release amount exceeds available funds");
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        let balance = client.balance(&env.current_contract_address());
        
        if balance < milestone_amount {
            panic!("Insufficient contract balance");
        }

        milestone.released = true;
        milestones.set(milestone_index, milestone);
        env.storage().instance().set(&DataKey::Milestones, &milestones);
        env.storage().instance().set(&DataKey::TotalReleased, &(total_released + milestone_amount));

        if milestone_amount > 0 {
            client.transfer(&env.current_contract_address(), &creator, &milestone_amount);
        }

        env.events().publish(
            (symbol_short!("release"), milestone_index),
            (creator, milestone_amount),
        );
    }

    pub fn refund(env: Env, contributor: Address) {
        contributor.require_auth();
        let status: Symbol = env.storage().instance().get(&DataKey::Status).unwrap();
        if status != symbol_short!("Failed") {
            panic!("Campaign has not failed");
        }

        let balance_key = DataKey::Contributions(contributor.clone());
        let amount: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        
        if amount <= 0 {
            panic!("No contribution to refund");
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&env.current_contract_address(), &contributor, &amount);

        env.storage().persistent().set(&balance_key, &0i128);
    }

    pub fn set_failed(env: Env) {
        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        let goal: i128 = env.storage().instance().get(&DataKey::Goal).unwrap();

        if env.ledger().timestamp() >= deadline && total_raised < goal {
            env.storage().instance().set(&DataKey::Status, &symbol_short!("Failed"));
        } else {
            let creator: Address = env.storage().instance().get(&DataKey::Creator).unwrap();
            creator.require_auth();
            env.storage().instance().set(&DataKey::Status, &symbol_short!("Failed"));
        }
    }

    pub fn get_status(env: Env) -> Symbol {
        env.storage().instance().get(&DataKey::Status).unwrap_or(symbol_short!("Active"))
    }

    pub fn get_total_raised(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0)
    }

    pub fn get_total_released(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalReleased).unwrap_or(0)
    }
}
