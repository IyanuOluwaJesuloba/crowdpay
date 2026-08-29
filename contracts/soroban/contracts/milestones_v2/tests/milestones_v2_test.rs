use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events},
    token, Address, BytesN, Env, Symbol, Vec,
};
use milestones_v2::{MilestonesV2Contract, MilestonesV2ContractClient, Milestone, MilestoneStatus};

fn make_milestone(env: &Env, title: &[u8; 32], bps: u32) -> Milestone {
    Milestone {
        title_hash: BytesN::from_array(env, title),
        release_bps: bps,
        status: MilestoneStatus::Pending,
        evidence_hash: None,
    }
}

fn install_token(env: &Env) -> (Address, token::StellarAssetClient) {
    let admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(admin.clone());
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);
    token_admin.mint(&admin, &10_000_000_000);
    (token_addr, token_admin)
}

#[contract]
pub struct MockEscrow;

#[derive(Clone)]
#[contracttype]
pub enum MockDataKey {
    ApprovedAmount,
    TotalMockRaised,
    MockAsset,
}

#[contractimpl]
impl MockEscrow {
    pub fn initialize(
        _env: Env,
        _admin: Address,
        _campaign_id: u64,
        _target: i128,
        _deadline: u64,
        _asset: Address,
        _fee_bps: u32,
        _fee_recipient: Address,
    ) {
    }

    pub fn deposit(_env: Env, _from: Address, _amount: i128) {}

    pub fn approve_withdrawal(env: Env, _to: Address, release_amount: i128) {
        let key = MockDataKey::ApprovedAmount;
        let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
        env.storage().instance().set(&key, &(current + release_amount));
    }

    pub fn execute_withdrawal(env: Env, _to: Address, release_amount: i128) {
        let key = MockDataKey::ApprovedAmount;
        let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
        if current < release_amount {
            panic!("Insufficient approved amount");
        }
        env.storage().instance().set(&key, &(current - release_amount));
    }

    pub fn get_total_raised(env: Env) -> i128 {
        env.storage().instance().get(&MockDataKey::TotalMockRaised).unwrap_or(0)
    }

    pub fn get_asset(env: Env) -> Address {
        env.storage().instance().get(&MockDataKey::MockAsset).unwrap()
    }
}

fn setup_v2_contract(
    env: &Env,
    milestones: Vec<Milestone>,
    escrow_total_raised: i128,
) -> (Address, Address, Address, Address) {
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let platform = Address::generate(&env);
    let (token_addr, _) = install_token(&env);

    let escrow_id = env.register(MockEscrow, ());
    let escrow_client = MockEscrowClient::new(&env, &escrow_id);

    escrow_client.initialize(
        &platform,
        &1u64,
        &10000,
        &999999,
        &token_addr,
        &0,
        &platform,
    );

    env.as_contract(&escrow_id, || {
        env.storage().instance().set(&MockDataKey::TotalMockRaised, &escrow_total_raised);
        env.storage().instance().set(&MockDataKey::MockAsset, &token_addr);
    });

    let contract_id = env.register(MilestonesV2Contract, ());
    let client = MilestonesV2ContractClient::new(&env, &contract_id);

    client.initialize(&creator, &platform, &escrow_id, &milestones);

    (contract_id, creator, platform, escrow_id)
}

#[test]
fn test_initialize_requires_platform_auth() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"INIT1111111111111111111111111111", 10000u32)],
    );
    let creator = Address::generate(&env);
    let platform = Address::generate(&env);
    let escrow_id = Address::generate(&env);
    let contract_id = env.register(MilestonesV2Contract, ());
    let client = MilestonesV2ContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&creator, &platform, &escrow_id, &milestones);
    }));
    assert!(result.is_err());
}

#[test]
fn test_get_version_returns_2() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"AAAA1111111111111111111111111111", 10000u32)],
    );
    let (contract_id, ..) = setup_v2_contract(&env, milestones, 1000);
    let client = MilestonesV2ContractClient::new(&env, &contract_id);

    assert_eq!(client.get_version(), 2);
}

#[test]
fn test_v2_preserves_v1_submit_approve_flow() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"BBBB1111111111111111111111111111", 10000u32)],
    );
    let (contract_id, ..) = setup_v2_contract(&env, milestones, 1000);
    let client = MilestonesV2ContractClient::new(&env, &contract_id);

    let evidence = BytesN::from_array(&env, b"evid_hash_1234567890123456789012");
    client.submit_milestone(&0u32, &evidence);
    assert_eq!(client.get_milestone(&0u32).status, MilestoneStatus::Submitted);

    client.approve_milestone(&0u32);
    assert_eq!(client.get_milestone(&0u32).status, MilestoneStatus::Approved);
}

#[test]
fn test_set_paused_blocks_submit_and_release_funds() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"CCCC1111111111111111111111111111", 10000u32)],
    );
    let (contract_id, ..) = setup_v2_contract(&env, milestones, 1000);
    let client = MilestonesV2ContractClient::new(&env, &contract_id);

    let evidence = BytesN::from_array(&env, b"evid_hash_1234567890123456789012");
    client.submit_milestone(&0u32, &evidence);

    client.set_paused(&true);
    assert!(client.is_paused());

    let submit_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.submit_milestone(&0u32, &evidence);
    }));
    assert!(submit_result.is_err());

    let approve_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.approve_milestone(&0u32);
    }));
    assert!(approve_result.is_err());

    client.set_paused(&false);
    client.approve_milestone(&0u32);
    assert_eq!(client.get_milestone(&0u32).status, MilestoneStatus::Approved);
}

#[test]
fn test_migrate_from_v1_copies_all_milestones() {
    let env = Env::default();
    env.mock_all_auths();

    let v1_milestones = Vec::from_array(
        &env,
        [
            make_milestone(&env, b"DDDD1111111111111111111111111111", 4000u32),
            make_milestone(&env, b"DDDD2222222222222222222222222222", 6000u32),
        ],
    );
    let (v1_id, _v1_creator, v1_platform, _v1_escrow) =
        setup_v2_contract(&env, v1_milestones.clone(), 1000);
    let v1_client = MilestonesV2ContractClient::new(&env, &v1_id);

    // Advance the "v1" contract's state so migration has something real to copy.
    let evidence = BytesN::from_array(&env, b"evid_hash_1234567890123456789012");
    v1_client.submit_milestone(&0u32, &evidence);
    v1_client.approve_milestone(&0u32);

    // Fresh v2 contract, initialized independently, sharing the same platform
    // address as v1 so a single platform key drives the migration.
    let creator = Address::generate(&env);
    let escrow_id = env.register(MockEscrow, ());
    let seed_milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"ZZZZ0000000000000000000000000000", 10000u32)],
    );
    let v2_id = env.register(MilestonesV2Contract, ());
    let v2_client = MilestonesV2ContractClient::new(&env, &v2_id);
    v2_client.initialize(&creator, &v1_platform, &escrow_id, &seed_milestones);

    v2_client.migrate_from_v1(&v1_id);

    assert_eq!(v2_client.get_version(), 2);

    let migrated = v2_client.get_all_milestones();
    assert_eq!(migrated.len(), v1_milestones.len());
    for i in 0..v1_milestones.len() {
        let expected = v1_client.get_milestone(&i);
        let actual = migrated.get(i).unwrap();
        assert_eq!(actual.title_hash, expected.title_hash);
        assert_eq!(actual.release_bps, expected.release_bps);
        assert_eq!(actual.status, expected.status);
        assert_eq!(actual.evidence_hash, expected.evidence_hash);
    }
}

#[test]
fn test_migrate_from_v1_rejects_non_platform() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"EEEE1111111111111111111111111111", 10000u32)],
    );

    let v1_creator = Address::generate(&env);
    let v1_platform = Address::generate(&env);
    let v1_escrow = env.register(MockEscrow, ());
    let v1_id = env.register(MilestonesV2Contract, ());
    MilestonesV2ContractClient::new(&env, &v1_id).mock_all_auths().initialize(
        &v1_creator, &v1_platform, &v1_escrow, &milestones,
    );

    let creator = Address::generate(&env);
    let platform = Address::generate(&env);
    let escrow_id = env.register(MockEscrow, ());
    let v2_id = env.register(MilestonesV2Contract, ());
    let v2_client = MilestonesV2ContractClient::new(&env, &v2_id);
    v2_client.mock_all_auths().initialize(&creator, &platform, &escrow_id, &milestones);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        v2_client.migrate_from_v1(&v1_id);
    }));
    assert!(result.is_err());
}
