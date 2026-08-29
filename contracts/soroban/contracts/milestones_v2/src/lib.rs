#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol, Vec, IntoVal
};

// V2 of the milestones contract (see contracts/soroban/contracts/milestones for V1).
//
// Soroban contracts cannot be arbitrarily upgraded in place, so a change to
// contract logic ships as a new contract deployment instead. This crate keeps
// every V1 function with an identical signature for ABI compatibility, and
// adds a version marker, a platform-controlled pause switch, and a
// migrate_from_v1 entry point that copies milestone state across from an
// already-deployed V1 contract. See contracts/soroban/contracts/migration
// for the orchestrator that drives a live upgrade end to end.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
pub enum MilestoneStatus {
    Pending = 0,
    Submitted = 1,
    Approved = 2,
    Rejected = 3,
}

#[derive(Clone)]
#[contracttype]
pub struct Milestone {
    pub title_hash: BytesN<32>,
    pub release_bps: u32,
    pub status: MilestoneStatus,
    pub evidence_hash: Option<BytesN<32>>,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Creator,
    Platform,
    Escrow,
    Milestones,
    Initialized,
    Paused,
    ContractVersion,
}

pub const CONTRACT_VERSION: u32 = 2;

#[contract]
pub struct MilestonesV2Contract;

#[contractimpl]
impl MilestonesV2Contract {
    pub fn initialize(
        env: Env,
        creator: Address,
        platform: Address,
        escrow: Address,
        milestones: Vec<Milestone>,
    ) {
        if env.storage().instance().has(&DataKey::Initialized) {
            panic!("Already initialized");
        }
        platform.require_auth();

        if creator == platform {
            panic!("Creator and platform must be distinct");
        }
        if milestones.is_empty() {
            panic!("Milestones cannot be empty");
        }

        let mut total_bps: u32 = 0;
        for m in milestones.iter() {
            total_bps += m.release_bps;
        }
        if total_bps != 10000 {
            panic!("Total BPS must be 10000");
        }

        env.storage().instance().set(&DataKey::Creator, &creator);
        env.storage().instance().set(&DataKey::Platform, &platform);
        env.storage().instance().set(&DataKey::Escrow, &escrow);
        env.storage().instance().set(&DataKey::Milestones, &milestones);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::ContractVersion, &CONTRACT_VERSION);
    }

    /// Callable by the platform only. Reads every milestone from an
    /// already-deployed V1 contract (`v1_contract_id`) via a cross-contract
    /// call to `get_all_milestones()` and writes it into this contract's own
    /// storage, replacing whatever milestones it was initialized with.
    pub fn migrate_from_v1(env: Env, v1_contract_id: Address) {
        let platform: Address = env.storage().instance().get(&DataKey::Platform).expect("Not initialized");
        platform.require_auth();

        let v1_milestones: Vec<Milestone> = env.invoke_contract(
            &v1_contract_id,
            &Symbol::new(&env, "get_all_milestones"),
            Vec::new(&env),
        );

        env.storage().instance().set(&DataKey::Milestones, &v1_milestones);
        env.storage().instance().set(&DataKey::ContractVersion, &CONTRACT_VERSION);

        env.events().publish(
            (symbol_short!("migrated"),),
            (v1_contract_id, v1_milestones.len()),
        );
    }

    pub fn get_version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::ContractVersion).unwrap_or(CONTRACT_VERSION)
    }

    /// Callable by the platform only. When paused, all state-mutating
    /// functions revert with CONTRACT_PAUSED.
    pub fn set_paused(env: Env, paused: bool) {
        let platform: Address = env.storage().instance().get(&DataKey::Platform).expect("Not initialized");
        platform.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    fn require_not_paused(env: &Env) {
        let paused: bool = env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        if paused {
            panic!("CONTRACT_PAUSED");
        }
    }

    pub fn submit_milestone(env: Env, index: u32, evidence_hash: BytesN<32>) {
        Self::require_not_paused(&env);
        let creator: Address = env.storage().instance().get(&DataKey::Creator).expect("Not initialized");
        creator.require_auth();

        let mut milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).expect("Not initialized");
        let mut milestone = milestones.get(index).expect("Invalid index");

        if milestone.status != MilestoneStatus::Pending && milestone.status != MilestoneStatus::Rejected {
            panic!("Milestone already submitted or approved");
        }

        milestone.status = MilestoneStatus::Submitted;
        milestone.evidence_hash = Some(evidence_hash.clone());
        milestones.set(index, milestone);
        env.storage().instance().set(&DataKey::Milestones, &milestones);

        env.events().publish(
            (symbol_short!("submit"), index),
            evidence_hash,
        );
    }

    /// Approves a submitted milestone and releases its share of escrow funds
    /// to the creator. This is the "release_funds" state-mutating function
    /// gated by set_paused.
    pub fn approve_milestone(env: Env, index: u32) {
        Self::require_not_paused(&env);
        let platform: Address = env.storage().instance().get(&DataKey::Platform).expect("Not initialized");
        platform.require_auth();

        let mut milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).expect("Not initialized");
        let mut milestone = milestones.get(index).expect("Invalid index");

        if milestone.status != MilestoneStatus::Submitted {
            panic!("Milestone not submitted");
        }

        milestone.status = MilestoneStatus::Approved;
        let release_bps = milestone.release_bps;
        milestones.set(index, milestone);
        env.storage().instance().set(&DataKey::Milestones, &milestones);

        let escrow_address: Address = env.storage().instance().get(&DataKey::Escrow).expect("Not initialized");
        let creator: Address = env.storage().instance().get(&DataKey::Creator).expect("Not initialized");

        let total_raised: i128 = env.invoke_contract(&escrow_address, &Symbol::new(&env, "get_total_raised"), Vec::new(&env));

        let release_amount = (total_raised * (release_bps as i128)) / 10000;

        if release_amount > 0 {
            let _ : () = env.invoke_contract(&escrow_address, &Symbol::new(&env, "approve_withdrawal"), (creator.clone(), release_amount).into_val(&env));
            let _ : () = env.invoke_contract(&escrow_address, &Symbol::new(&env, "execute_withdrawal"), (creator.clone(), release_amount).into_val(&env));

            env.events().publish(
                (symbol_short!("release"), index),
                (creator, release_amount),
            );
        }

        env.events().publish(
            (symbol_short!("approve"), index),
            (),
        );
    }

    pub fn reject_milestone(env: Env, index: u32, reason_hash: BytesN<32>) {
        Self::require_not_paused(&env);
        let platform: Address = env.storage().instance().get(&DataKey::Platform).expect("Not initialized");
        platform.require_auth();

        let mut milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).expect("Not initialized");
        let mut milestone = milestones.get(index).expect("Invalid index");

        if milestone.status != MilestoneStatus::Submitted {
            panic!("Milestone not submitted");
        }

        milestone.status = MilestoneStatus::Rejected;
        milestones.set(index, milestone);
        env.storage().instance().set(&DataKey::Milestones, &milestones);

        env.events().publish(
            (symbol_short!("reject"), index),
            reason_hash,
        );
    }

    pub fn get_milestone(env: Env, index: u32) -> Milestone {
        let milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).expect("Not initialized");
        milestones.get(index).expect("Invalid index")
    }

    pub fn get_all_milestones(env: Env) -> Vec<Milestone> {
        env.storage().instance().get(&DataKey::Milestones).expect("Not initialized")
    }

    pub fn get_milestone_count(env: Env) -> u32 {
        let milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).expect("Not initialized");
        milestones.len()
    }
}
