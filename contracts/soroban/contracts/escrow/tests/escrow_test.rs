use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};
use escrow::{EscrowContract, EscrowContractClient};

fn install_token(env: &Env) -> (Address, token::StellarAssetClient) {
    let admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(admin.clone());
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);
    token_admin.mint(&admin, &10_000_000_000);
    (token_addr, token_admin)
}

fn setup_contract(
    env: &Env,
    target: i128,
    deadline: u64,
    fee_bps: u32,
) -> (Address, Address, Address, Address) {
    let admin = Address::generate(&env);
    let contributor = Address::generate(&env);
    let fee_recipient = Address::generate(&env);

    env.mock_all_auths();

    let (token_addr, _token_admin) = install_token(&env);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    client.initialize(
        &admin,
        &1u64,
        &target,
        &deadline,
        &token_addr,
        &fee_bps,
        &fee_recipient,
    );

    (contract_id, admin, contributor, fee_recipient)
}

#[test]
fn test_initialize_sets_state() {
    let env = Env::default();
    let (contract_id, _, _, fee_recipient) = setup_contract(&env, 1000, 100, 500);

    let client = EscrowContractClient::new(&env, &contract_id);

    let total_raised: i128 = client.get_total_raised();
    assert_eq!(total_raised, 0);

    let (bps, recipient) = client.get_platform_fee_config();
    assert_eq!(bps, 500);
    assert_eq!(recipient, fee_recipient);
}

#[test]
fn test_initialize_requires_fee_recipient_auth() {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let env = Env::default();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let fee_recipient = Address::generate(&env);
        let token_addr = env.register_stellar_asset_contract(admin.clone());

        // Without mock_all_auths, initialize fails because fee_recipient auth is required
        client.initialize(&admin, &1u64, &1000, &999999, &token_addr, &100, &fee_recipient);
    }));
    assert!(result.is_err());
}

#[test]
fn test_initialize_rejects_reinit() {
    let env = Env::default();
    let (contract_id, admin, _, fee_recipient) = setup_contract(&env, 1000, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr: Address = client.get_asset();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin, &2u64, &2000, &200, &token_addr, &0, &fee_recipient);
    }));
    assert!(result.is_err());
}

#[test]
fn test_initialize_rejects_invalid_fee() {
    let env = Env::default();

    env.mock_all_auths();

    let admin = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let (token_addr, _) = install_token(&env);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin, &1u64, &1000, &100, &token_addr, &10001, &fee_recipient);
    }));
    assert!(result.is_err());
}

#[test]
fn test_initialize_rejects_fee_above_cap() {
    let env = Env::default();

    env.mock_all_auths();

    let admin = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let (token_addr, _) = install_token(&env);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    // 1001 BPS is one basis point above the 10% cap and must be rejected.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin, &1u64, &1000, &100, &token_addr, &1001, &fee_recipient);
    }));
    assert!(result.is_err());
}

#[test]
fn test_initialize_accepts_fee_at_cap() {
    let env = Env::default();
    let (contract_id, _, _, _) = setup_contract(&env, 1000, 100, 1000);

    let client = EscrowContractClient::new(&env, &contract_id);
    let (bps, _) = client.get_platform_fee_config();
    assert_eq!(bps, 1000);
}

#[test]
fn test_propose_and_confirm_fee_change() {
    let env = Env::default();
    let (contract_id, _admin, _, _fee_recipient) = setup_contract(&env, 1000, 999999, 100);
    let client = EscrowContractClient::new(&env, &contract_id);

    // Proposing does not change the active fee.
    client.propose_fee_change(&500);
    assert_eq!(client.get_pending_fee(), Some(500));
    let (bps, _) = client.get_platform_fee_config();
    assert_eq!(bps, 100);

    // Confirmation applies the pending fee and clears the proposal.
    client.confirm_fee_change();
    let (bps, _) = client.get_platform_fee_config();
    assert_eq!(bps, 500);
    assert_eq!(client.get_pending_fee(), None);
}

#[test]
fn test_propose_fee_change_rejects_above_cap() {
    let env = Env::default();
    let (contract_id, _admin, _, _fee_recipient) = setup_contract(&env, 1000, 999999, 100);
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.propose_fee_change(&1001);
    }));
    assert!(result.is_err());

    // The active fee is untouched and nothing is left pending.
    let (bps, _) = client.get_platform_fee_config();
    assert_eq!(bps, 100);
    assert_eq!(client.get_pending_fee(), None);
}

#[test]
fn test_confirm_fee_change_rejects_when_no_pending() {
    let env = Env::default();
    let (contract_id, _admin, _, _fee_recipient) = setup_contract(&env, 1000, 999999, 100);
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.confirm_fee_change();
    }));
    assert!(result.is_err());
}

#[test]
fn test_cancel_fee_change() {
    let env = Env::default();
    let (contract_id, _admin, _, _fee_recipient) = setup_contract(&env, 1000, 999999, 100);
    let client = EscrowContractClient::new(&env, &contract_id);

    client.propose_fee_change(&500);
    client.cancel_fee_change();

    assert_eq!(client.get_pending_fee(), None);
    let (bps, _) = client.get_platform_fee_config();
    assert_eq!(bps, 100);
}

#[test]
fn test_fee_change_requires_admin_auth() {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let env = Env::default();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        // Without auth mocking, propose_fee_change fails without admin auth
        client.propose_fee_change(&500);
    }));
    assert!(result.is_err());
}

#[test]
fn test_deposit_increases_balance() {
    let env = Env::default();
    let (contract_id, _, contributor, _fee_recipient) = setup_contract(&env, 1000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &500);
    client.deposit(&contributor, &500);

    let total_raised: i128 = client.get_total_raised();
    assert_eq!(total_raised, 500);
}

#[test]
fn test_deposit_rejects_after_deadline() {
    let env = Env::default();
    let (contract_id, _, contributor, _fee_recipient) = setup_contract(&env, 1000, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &100);

    env.ledger().set_timestamp(200);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.deposit(&contributor, &100);
    }));
    assert!(result.is_err());
    assert_eq!(client.get_total_raised(), 0);
}

#[test]
fn test_deposit_multiple_contributors() {
    let env = Env::default();
    let (contract_id, _, contributor, _fee_recipient) = setup_contract(&env, 5000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    let contributor2 = Address::generate(&env);
    token_cl.mint(&contributor, &1000);
    token_cl.mint(&contributor2, &2000);

    client.deposit(&contributor, &1000);
    client.deposit(&contributor2, &2000);

    let total_raised: i128 = client.get_total_raised();
    assert_eq!(total_raised, 3000);
}

#[test]
fn test_approve_withdrawal_increases_approved() {
    let env = Env::default();
    let (contract_id, admin, _, _fee_recipient) = setup_contract(&env, 1000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    client.approve_withdrawal(&admin, &500);

    assert_eq!(client.get_approved_withdrawal(&admin), 500);
    let total_raised: i128 = client.get_total_raised();
    assert_eq!(total_raised, 0);
}

#[test]
fn test_execute_withdrawal_deducts_fee() {
    let env = Env::default();
    let (contract_id, admin, contributor, fee_recipient) =
        setup_contract(&env, 1000, 999999, 1000);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &1000);
    client.deposit(&contributor, &1000);

    client.approve_withdrawal(&admin, &500);
    client.execute_withdrawal(&admin, &500);

    let fee = 50i128;
    let net = 450i128;

    let token_client = token::Client::new(&env, &token_addr);
    assert_eq!(token_client.balance(&contributor), 0);
    assert_eq!(token_client.balance(&admin), net);
    assert_eq!(token_client.balance(&fee_recipient), fee);
    assert_eq!(client.get_approved_withdrawal(&admin), 0);
}

#[test]
fn test_execute_withdrawal_no_fee() {
    let env = Env::default();
    let (contract_id, admin, contributor, _fee_recipient) = setup_contract(&env, 1000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &1000);
    client.deposit(&contributor, &1000);

    client.approve_withdrawal(&admin, &500);
    client.execute_withdrawal(&admin, &500);

    let token_client = token::Client::new(&env, &token_addr);
    assert_eq!(token_client.balance(&admin), 500);
    assert_eq!(client.get_approved_withdrawal(&admin), 0);
}

#[test]
fn test_execute_withdrawal_rejects_insufficient_approval() {
    let env = Env::default();
    let (contract_id, admin, _, _fee_recipient) = setup_contract(&env, 1000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_withdrawal(&admin, &500);
    }));
    assert!(result.is_err());
}

#[test]
fn test_approve_withdrawal_requires_admin_auth() {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let env = Env::default();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        // Call without mock_all_auths - approve_withdrawal requires admin auth
        client.approve_withdrawal(&admin, &100);
    }));
    assert!(result.is_err());
}

#[test]
fn test_execute_withdrawal_requires_admin_auth() {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let env = Env::default();
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let dest = Address::generate(&env);
        client.execute_withdrawal(&dest, &100);
    }));
    assert!(result.is_err());
}

#[test]
fn test_execute_withdrawal_rejects_unapproved_destination() {
    let env = Env::default();
    let (contract_id, admin, contributor, _fee_recipient) = setup_contract(&env, 1000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &1000);
    client.deposit(&contributor, &1000);

    // Approve withdrawal for legitimate admin/creator
    client.approve_withdrawal(&admin, &500);

    // Attacker tries to execute withdrawal redirecting funds to attacker address
    let attacker = Address::generate(&env);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_withdrawal(&attacker, &500);
    }));
    assert!(result.is_err());
}

#[test]
fn test_execute_withdrawal_multiple_destinations_independent() {
    let env = Env::default();
    let (contract_id, _admin, contributor, _fee_recipient) = setup_contract(&env, 3000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &3000);
    client.deposit(&contributor, &3000);

    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    client.approve_withdrawal(&recipient1, &400);
    client.approve_withdrawal(&recipient2, &600);

    assert_eq!(client.get_approved_withdrawal(&recipient1), 400);
    assert_eq!(client.get_approved_withdrawal(&recipient2), 600);

    client.execute_withdrawal(&recipient1, &400);
    assert_eq!(client.get_approved_withdrawal(&recipient1), 0);
    assert_eq!(client.get_approved_withdrawal(&recipient2), 600);

    let token_client = token::Client::new(&env, &token_addr);
    assert_eq!(token_client.balance(&recipient1), 400);
    assert_eq!(token_client.balance(&recipient2), 0);

    client.execute_withdrawal(&recipient2, &600);
    assert_eq!(client.get_approved_withdrawal(&recipient2), 0);
    assert_eq!(token_client.balance(&recipient2), 600);
}

#[test]
fn test_refund_after_deadline_when_under_target() {
    let env = Env::default();
    let (contract_id, _admin, contributor, _fee_recipient) = setup_contract(&env, 1000, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &500);
    client.deposit(&contributor, &500);

    env.ledger().set_timestamp(200);

    let token_client = token::Client::new(&env, &token_addr);
    let balance_before = token_client.balance(&contributor);
    assert_eq!(balance_before, 0);

    client.refund(&contributor);

    let balance_after = token_client.balance(&contributor);
    assert_eq!(balance_after, 500);

    let total_raised: i128 = client.get_total_raised();
    assert_eq!(total_raised, 0);
}

#[test]
fn test_refund_rejects_before_deadline() {
    let env = Env::default();
    let (contract_id, _admin, contributor, _fee_recipient) = setup_contract(&env, 1000, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(50);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.refund(&contributor);
    }));
    assert!(result.is_err());
}

#[test]
fn test_refund_rejects_when_target_met() {
    let env = Env::default();
    let (contract_id, _admin, contributor, _fee_recipient) = setup_contract(&env, 500, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &500);
    client.deposit(&contributor, &500);

    env.ledger().set_timestamp(200);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.refund(&contributor);
    }));
    assert!(result.is_err());
}

#[test]
fn test_refund_rejects_no_contribution() {
    let env = Env::default();
    let (contract_id, _admin, contributor, _fee_recipient) = setup_contract(&env, 1000, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(200);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.refund(&contributor);
    }));
    assert!(result.is_err());
}

#[test]
fn test_full_flow_deposit_withdraw_with_fee() {
    let env = Env::default();
    let (contract_id, admin, contributor, fee_recipient) =
        setup_contract(&env, 2000, 999999, 500);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &1000);
    client.deposit(&contributor, &1000);

    let total: i128 = client.get_total_raised();
    assert_eq!(total, 1000);

    client.approve_withdrawal(&admin, &800);
    client.execute_withdrawal(&admin, &800);

    let fee = 40i128;
    let net = 760i128;

    let token_client = token::Client::new(&env, &token_addr);
    assert_eq!(token_client.balance(&admin), net);
    assert_eq!(token_client.balance(&fee_recipient), fee);

    let remaining = 200i128;
    assert_eq!(token_client.balance(&contract_id), remaining);
}
