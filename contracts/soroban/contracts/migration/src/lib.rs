#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, IntoVal};

// Standalone one-shot migration orchestrator: drives a live upgrade from a
// milestones V1 contract to a milestones V2 contract (see
// contracts/soroban/contracts/milestones and .../milestones_v2) in a single
// transaction, so campaign activity is never left half-migrated.

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Platform,
    Initialized,
}

#[contract]
pub struct MigrationContract;

#[contractimpl]
impl MigrationContract {
    pub fn initialize(env: Env, platform: Address) {
        if env.storage().instance().has(&DataKey::Initialized) {
            panic!("Already initialized");
        }
        platform.require_auth();
        env.storage().instance().set(&DataKey::Platform, &platform);
        env.storage().instance().set(&DataKey::Initialized, &true);
    }

    /// Callable by the platform only. Pauses the V1 contract, has V2 pull
    /// its state across, then emits MigrationCompleted with the number of
    /// milestones that were carried over.
    pub fn migrate(env: Env, v1_contract_id: Address, v2_contract_id: Address) {
        let platform: Address = env.storage().instance().get(&DataKey::Platform).expect("Not initialized");
        platform.require_auth();

        let _: () = env.invoke_contract(
            &v1_contract_id,
            &Symbol::new(&env, "set_paused"),
            (true,).into_val(&env),
        );

        let _: () = env.invoke_contract(
            &v2_contract_id,
            &Symbol::new(&env, "migrate_from_v1"),
            (v1_contract_id.clone(),).into_val(&env),
        );

        let milestone_count: u32 = env.invoke_contract(
            &v2_contract_id,
            &Symbol::new(&env, "get_milestone_count"),
            soroban_sdk::Vec::new(&env),
        );

        env.events().publish(
            (Symbol::new(&env, "MigrationCompleted"),),
            (v1_contract_id, v2_contract_id, milestone_count),
        );
    }
}
