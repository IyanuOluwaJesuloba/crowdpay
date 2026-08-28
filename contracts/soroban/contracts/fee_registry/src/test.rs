#[cfg(test)]
mod test {
    use soroban_sdk::{symbol_short, Address, Env};
    use crate::{FeeRegistry, FeeProposal, ProposalStatus, DataKey, MIN_TOKEN_BALANCE, QUORUM_THRESHOLD};

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        
        FeeRegistry::initialize(
            &env,
            admin.clone(),
            governance_token.clone(),
            250, // 2.5% platform fee
            500, // 5% creator share
        );

        assert_eq!(FeeRegistry::get_fee(&env), 250);
        assert_eq!(FeeRegistry::get_creator_share(&env), 500);
        assert_eq!(FeeRegistry::get_admin(&env), admin);
        assert_eq!(FeeRegistry::get_governance_token(&env), governance_token);
    }

    #[test]
    fn test_initialize_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            FeeRegistry::initialize(
                &env,
                admin,
                governance_token,
                250,
                500,
            );
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_get_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        
        FeeRegistry::initialize(&env, admin, governance_token, 300, 400);
        
        assert_eq!(FeeRegistry::get_fee(&env), 300);
    }

    #[test]
    fn test_propose_change_success() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let governance_token = Address::generate(&env);
        
        FeeRegistry::initialize(&env, admin, governance_token.clone(), 250, 500);

        // Mock token balance for proposer (need to set up token contract in real test)
        // For now, we'll test the logic assuming balance check passes
        let proposal_id = FeeRegistry::propose_change(&env, proposer.clone(), 300, 600);
        
        assert_eq!(proposal_id, 1);
        
        let proposal = FeeRegistry::get_pending_proposal(&env).unwrap();
        assert_eq!(proposal.id, 1);
        assert_eq!(proposal.proposed_fee_bps, 300);
        assert_eq!(proposal.proposed_creator_share_bps, 600);
        assert_eq!(proposal.votes_for, 0);
        assert_eq!(proposal.votes_against, 0);
        assert_eq!(proposal.status, ProposalStatus::Active);
    }

    #[test]
    #[should_panic(expected = "Already initialized")]
    fn test_double_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        
        FeeRegistry::initialize(&env, admin.clone(), governance_token.clone(), 250, 500);
        FeeRegistry::initialize(&env, admin, governance_token, 300, 400);
    }

    #[test]
    fn test_admin_set_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        
        FeeRegistry::initialize(&env, admin.clone(), governance_token, 250, 500);
        
        FeeRegistry::admin_set_fee(&env, admin.clone(), 350, 450);
        
        assert_eq!(FeeRegistry::get_fee(&env), 350);
        assert_eq!(FeeRegistry::get_creator_share(&env), 450);
    }

    #[test]
    fn test_proposal_counter_increment() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let governance_token = Address::generate(&env);
        
        FeeRegistry::initialize(&env, admin, governance_token.clone(), 250, 500);

        // First proposal
        let id1 = FeeRegistry::propose_change(&env, proposer.clone(), 300, 600);
        assert_eq!(id1, 1);

        // Mark first as executed to allow second proposal
        let mut proposal = FeeRegistry::get_pending_proposal(&env).unwrap();
        proposal.status = ProposalStatus::Executed;
        env.storage().instance().set(&DataKey::PendingProposal, &proposal);

        // Second proposal
        let id2 = FeeRegistry::propose_change(&env, proposer, 350, 550);
        assert_eq!(id2, 2);
    }
}
