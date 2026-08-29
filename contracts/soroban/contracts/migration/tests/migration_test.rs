use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Vec};

use migration::{MigrationContract, MigrationContractClient};
use milestones::{Milestone as V1Milestone, MilestoneStatus as V1Status, MilestonesContract, MilestonesContractClient};
use milestones_v2::{Milestone as V2Milestone, MilestoneStatus as V2Status, MilestonesV2Contract, MilestonesV2ContractClient};

fn v1_milestone(env: &Env, title: &[u8; 32], bps: u32) -> V1Milestone {
    V1Milestone {
        title_hash: BytesN::from_array(env, title),
        release_bps: bps,
        status: V1Status::Pending,
        evidence_hash: None,
    }
}

fn v2_milestone(env: &Env, title: &[u8; 32], bps: u32) -> V2Milestone {
    V2Milestone {
        title_hash: BytesN::from_array(env, title),
        release_bps: bps,
        status: V2Status::Pending,
        evidence_hash: None,
    }
}

#[test]
fn test_migrate_pauses_v1_and_copies_state_into_v2_emitting_one_event() {
    let env = Env::default();
    env.mock_all_auths();

    let platform = Address::generate(&env);
    let v1_creator = Address::generate(&env);
    let v1_escrow = Address::generate(&env);
    let v1_milestones = Vec::from_array(
        &env,
        [
            v1_milestone(&env, b"AAAA1111111111111111111111111111", 4000u32),
            v1_milestone(&env, b"AAAA2222222222222222222222222222", 6000u32),
        ],
    );
    let v1_id = env.register(MilestonesContract, ());
    MilestonesContractClient::new(&env, &v1_id).initialize(
        &v1_creator, &platform, &v1_escrow, &v1_milestones,
    );

    let v2_creator = Address::generate(&env);
    let v2_escrow = Address::generate(&env);
    let seed_milestones = Vec::from_array(
        &env,
        [v2_milestone(&env, b"ZZZZ0000000000000000000000000000", 10000u32)],
    );
    let v2_id = env.register(MilestonesV2Contract, ());
    MilestonesV2ContractClient::new(&env, &v2_id).initialize(
        &v2_creator, &platform, &v2_escrow, &seed_milestones,
    );

    let migration_id = env.register(MigrationContract, ());
    let migration_client = MigrationContractClient::new(&env, &migration_id);
    migration_client.initialize(&platform);

    migration_client.migrate(&v1_id, &v2_id);

    let v1_client = MilestonesContractClient::new(&env, &v1_id);
    assert!(v1_client.is_paused());

    let v2_client = MilestonesV2ContractClient::new(&env, &v2_id);
    assert_eq!(v2_client.get_version(), 2);
    let migrated = v2_client.get_all_milestones();
    assert_eq!(migrated.len(), v1_milestones.len());
    for i in 0..v1_milestones.len() {
        assert_eq!(migrated.get(i).unwrap().release_bps, v1_milestones.get(i).unwrap().release_bps);
    }

    // migrate() publishes exactly one event, from this contract: MigrationCompleted.
    let migration_events: Vec<_> = env
        .events()
        .all()
        .iter()
        .filter(|(contract_id, ..)| *contract_id == migration_id)
        .collect();
    assert_eq!(migration_events.len(), 1, "MigrationCompleted must be emitted exactly once");
}

#[test]
fn test_initialize_requires_platform_auth() {
    let env = Env::default();
    let platform = Address::generate(&env);
    let migration_id = env.register(MigrationContract, ());
    let migration_client = MigrationContractClient::new(&env, &migration_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        migration_client.initialize(&platform);
    }));
    assert!(result.is_err());
}

#[test]
fn test_migrate_rejects_non_platform() {
    let env = Env::default();

    let platform = Address::generate(&env);
    let v1_creator = Address::generate(&env);
    let v1_escrow = Address::generate(&env);
    let v1_milestones = Vec::from_array(
        &env,
        [v1_milestone(&env, b"BBBB1111111111111111111111111111", 10000u32)],
    );
    let v1_id = env.register(MilestonesContract, ());
    MilestonesContractClient::new(&env, &v1_id).mock_all_auths().initialize(
        &v1_creator, &platform, &v1_escrow, &v1_milestones,
    );

    let v2_creator = Address::generate(&env);
    let v2_escrow = Address::generate(&env);
    let v2_id = env.register(MilestonesV2Contract, ());
    MilestonesV2ContractClient::new(&env, &v2_id).mock_all_auths().initialize(
        &v2_creator, &platform, &v2_escrow, &v1_milestones,
    );

    let migration_id = env.register(MigrationContract, ());
    let migration_client = MigrationContractClient::new(&env, &migration_id);
    migration_client.mock_all_auths().initialize(&platform);

    // No mock_all_auths() on migration_client.migrate: platform.require_auth() inside migrate() must fail.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        migration_client.migrate(&v1_id, &v2_id);
    }));
    assert!(result.is_err());
}
