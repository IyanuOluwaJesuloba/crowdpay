use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events},
    token, Address, BytesN, Env, Symbol, Vec,
};
use milestones::{MilestonesContract, MilestonesContractClient, Milestone, MilestoneStatus};

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

fn setup_milestones_contract(
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

    let total_key = MockDataKey::TotalMockRaised;
    env.as_contract(&escrow_id, || {
        env.storage().instance().set(&total_key, &escrow_total_raised);
    });

    let asset_key = MockDataKey::MockAsset;
    env.as_contract(&escrow_id, || {
        env.storage().instance().set(&asset_key, &token_addr);
    });

    let contract_id = env.register(MilestonesContract, ());
    let client = MilestonesContractClient::new(&env, &contract_id);

    client.initialize(&creator, &platform, &escrow_id, &milestones);

    (contract_id, creator, platform, escrow_id)
}

fn setup_no_auth(
    env: &Env,
    milestones: Vec<Milestone>,
) -> (Address, Address, Address) {
    let creator = Address::generate(&env);
    let platform = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(Address::generate(&env));

    let escrow_id = env.register(MockEscrow, ());
    let escrow_client = MockEscrowClient::new(&env, &escrow_id);
    escrow_client.mock_all_auths().initialize(
        &platform,
        &1u64,
        &10000,
        &999999,
        &token_addr,
        &0,
        &platform,
    );

    let total_key = MockDataKey::TotalMockRaised;
    env.as_contract(&escrow_id, || {
        env.storage().instance().set(&total_key, &1000i128);
    });

    let asset_key = MockDataKey::MockAsset;
    env.as_contract(&escrow_id, || {
        env.storage().instance().set(&asset_key, &token_addr);
    });

    let contract_id = env.register(MilestonesContract, ());
    let client = MilestonesContractClient::new(&env, &contract_id);

    client.mock_all_auths().initialize(&creator, &platform, &escrow_id, &milestones);

    (contract_id, creator, platform)
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
    let contract_id = env.register(MilestonesContract, ());
    let client = MilestonesContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&creator, &platform, &escrow_id, &milestones);
    }));
    assert!(result.is_err());
}

#[test]
fn test_initialize_valid_bps() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [
            make_milestone(&env, b"AAAA1111111111111111111111111111", 5000u32),
            make_milestone(&env, b"AAAA2222222222222222222222222222", 5000u32),
        ],
    );
    setup_milestones_contract(&env, milestones, 1000);
}

#[test]
fn test_initialize_rejects_invalid_bps() {
    let env = Env::default();

    env.mock_all_auths();

    let milestones = Vec::from_array(
        &env,
        [
            make_milestone(&env, b"BBBB1111111111111111111111111111", 3000u32),
            make_milestone(&env, b"BBBB2222222222222222222222222222", 3000u32),
        ],
    );

    let creator = Address::generate(&env);
    let platform = Address::generate(&env);
    let (token_addr, _) = install_token(&env);
    let escrow_id = env.register(MockEscrow, ());
    let contract_id = env.register(MilestonesContract, ());
    let client = MilestonesContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&creator, &platform, &escrow_id, &milestones);
    }));
    assert!(result.is_err());
}

#[test]
fn test_submit_milestone() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [
            make_milestone(&env, b"CCCC1111111111111111111111111111", 5000u32),
            make_milestone(&env, b"CCCC2222222222222222222222222222", 5000u32),
        ],
    );

    let (contract_id, creator, _platform, _escrow) =
        setup_milestones_contract(&env, milestones, 1000);
    let client = MilestonesContractClient::new(&env, &contract_id);

    let evidence = BytesN::from_array(&env, b"evid_hash_1234567890123456789012");

    client.submit_milestone(&0u32, &evidence);

    let milestone = client.get_milestone(&0u32);
    assert_eq!(milestone.status, MilestoneStatus::Submitted);
    assert_eq!(milestone.evidence_hash, Some(evidence));
}

#[test]
fn test_submit_milestone_rejects_non_creator() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"DDDD1111111111111111111111111111", 10000u32)],
    );

    let (contract_id, _creator, _platform) = setup_no_auth(&env, milestones);
    let client = MilestonesContractClient::new(&env, &contract_id);
    let evidence = BytesN::from_array(&env, b"evid_hash_1234567890123456789012");

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.submit_milestone(&0u32, &evidence);
    }));
    assert!(result.is_err());
}

#[test]
fn test_approve_milestone_platform_only() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"EEEE1111111111111111111111111111", 10000u32)],
    );

    let (contract_id, creator, platform, _escrow) =
        setup_milestones_contract(&env, milestones, 1000);
    let client = MilestonesContractClient::new(&env, &contract_id);

    let evidence = BytesN::from_array(&env, b"evid_hash_1234567890123456789012");
    client.submit_milestone(&0u32, &evidence);

    client.approve_milestone(&0u32);

    let milestone = client.get_milestone(&0u32);
    assert_eq!(milestone.status, MilestoneStatus::Approved);
}

#[test]
fn test_approve_milestone_rejects_non_platform() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"FFFF1111111111111111111111111111", 10000u32)],
    );

    let (contract_id, creator, _platform) = setup_no_auth(&env, milestones);
    let client = MilestonesContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.approve_milestone(&0u32);
    }));
    assert!(result.is_err());
}

#[test]
fn test_reject_milestone() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"GGGG1111111111111111111111111111", 10000u32)],
    );

    let (contract_id, creator, platform, _escrow) =
        setup_milestones_contract(&env, milestones, 1000);
    let client = MilestonesContractClient::new(&env, &contract_id);

    let evidence = BytesN::from_array(&env, b"evid_hash_1234567890123456789012");
    client.submit_milestone(&0u32, &evidence);

    let reason = BytesN::from_array(&env, b"rsn_hash_12345678901234567890123");
    client.reject_milestone(&0u32, &reason);

    let milestone = client.get_milestone(&0u32);
    assert_eq!(milestone.status, MilestoneStatus::Rejected);
}

#[test]
fn test_reject_milestone_rejects_non_platform() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"HHHH1111111111111111111111111111", 10000u32)],
    );

    let (contract_id, creator, _platform) = setup_no_auth(&env, milestones);
    let client = MilestonesContractClient::new(&env, &contract_id);
    let reason = BytesN::from_array(&env, b"rsn_hash_12345678901234567890123");

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.reject_milestone(&0u32, &reason);
    }));
    assert!(result.is_err());
}

#[test]
fn test_get_all_milestones() {
    let env = Env::default();
    let expected_milestones = Vec::from_array(
        &env,
        [
            make_milestone(&env, b"IIII1111111111111111111111111111", 3000u32),
            make_milestone(&env, b"IIII2222222222222222222222222222", 3000u32),
            make_milestone(&env, b"IIII3333333333333333333333333333", 4000u32),
        ],
    );

    let (contract_id, _creator, _platform, _escrow) =
        setup_milestones_contract(&env, expected_milestones.clone(), 1000);
    let client = MilestonesContractClient::new(&env, &contract_id);

    let all = client.get_all_milestones();
    assert_eq!(all.len(), 3);

    for (i, m) in all.iter().enumerate() {
        let expected = expected_milestones.get(i as u32).unwrap();
        assert_eq!(m.release_bps, expected.release_bps);
        assert_eq!(m.status, MilestoneStatus::Pending);
    }
}

#[test]
fn test_set_paused_blocks_submit_and_approve() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"KKKK1111111111111111111111111111", 10000u32)],
    );

    let (contract_id, _creator, platform, _escrow) =
        setup_milestones_contract(&env, milestones, 1000);
    let client = MilestonesContractClient::new(&env, &contract_id);

    client.set_paused(&true);
    assert!(client.is_paused());

    let evidence = BytesN::from_array(&env, b"evid_hash_1234567890123456789012");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.submit_milestone(&0u32, &evidence);
    }));
    assert!(result.is_err());

    client.set_paused(&false);
    client.submit_milestone(&0u32, &evidence);

    client.set_paused(&true);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.approve_milestone(&0u32);
    }));
    assert!(result.is_err());
}

#[test]
fn test_set_paused_rejects_non_platform() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"LLLL1111111111111111111111111111", 10000u32)],
    );

    let (contract_id, _creator, _platform) = setup_no_auth(&env, milestones);
    let client = MilestonesContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_paused(&true);
    }));
    assert!(result.is_err());
}

#[test]
fn test_resubmit_after_rejection() {
    let env = Env::default();
    let milestones = Vec::from_array(
        &env,
        [make_milestone(&env, b"JJJJ1111111111111111111111111111", 10000u32)],
    );

    let (contract_id, creator, platform, _escrow) =
        setup_milestones_contract(&env, milestones, 1000);
    let client = MilestonesContractClient::new(&env, &contract_id);
    let evidence = BytesN::from_array(&env, b"evid_hash_1234567890123456789012");

    client.submit_milestone(&0u32, &evidence);

    let reason = BytesN::from_array(&env, b"rsn_hash_12345678901234567890123");
    client.reject_milestone(&0u32, &reason);

    let new_evidence = BytesN::from_array(&env, b"new_evid_hash_123456789012345678");
    client.submit_milestone(&0u32, &new_evidence);

    let milestone = client.get_milestone(&0u32);
    assert_eq!(milestone.status, MilestoneStatus::Submitted);
    assert_eq!(milestone.evidence_hash, Some(new_evidence));
}
