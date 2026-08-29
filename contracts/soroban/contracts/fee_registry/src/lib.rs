#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec, token};

#[cfg(test)]
mod test;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Failed,
    Executed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeProposal {
    pub id: u32,
    pub proposed_fee_bps: u32,
    pub proposed_creator_share_bps: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    pub deadline: u64,
    pub status: ProposalStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    PlatformFeeBps,
    CreatorShareBps,
    GovernanceToken,
    Admin,
    PendingProposal,
    ProposalCounter,
    ProposalVotes(u32, Address), // proposal_id, voter_address
}

const PROPOSAL_VOTING_PERIOD: u64 = 7 * 24 * 60 * 60; // 7 days in seconds
const MIN_TOKEN_BALANCE: i128 = 1000; // Minimum 1000 tokens to propose
const QUORUM_THRESHOLD: i128 = 1000; // 10% of total supply (assuming 10,000 total supply)

#[contract]
pub struct FeeRegistry;

#[contractimpl]
impl FeeRegistry {
    pub fn initialize(
        env: Env,
        admin: Address,
        governance_token: Address,
        initial_platform_fee_bps: u32,
        initial_creator_share_bps: u32,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        admin.require_auth();

        if initial_platform_fee_bps > 10000 || initial_creator_share_bps > 10000 {
            panic!("Invalid fee bps");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::GovernanceToken, &governance_token);
        env.storage().instance().set(&DataKey::PlatformFeeBps, &initial_platform_fee_bps);
        env.storage().instance().set(&DataKey::CreatorShareBps, &initial_creator_share_bps);
        env.storage().instance().set(&DataKey::ProposalCounter, &0u32);
    }

    pub fn get_fee(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::PlatformFeeBps).unwrap_or(0)
    }

    pub fn get_creator_share(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::CreatorShareBps).unwrap_or(0)
    }

    pub fn get_governance_token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::GovernanceToken).unwrap()
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn get_pending_proposal(env: Env) -> Option<FeeProposal> {
        env.storage().instance().get(&DataKey::PendingProposal)
    }

    pub fn propose_change(
        env: Env,
        proposer: Address,
        new_fee_bps: u32,
        new_creator_share_bps: u32,
    ) -> u32 {
        proposer.require_auth();

        // Check if proposer has minimum token balance
        let governance_token: Address = env.storage().instance().get(&DataKey::GovernanceToken).unwrap();
        let token_client = token::Client::new(&env, &governance_token);
        let proposer_balance = token_client.balance(&proposer);

        if proposer_balance < MIN_TOKEN_BALANCE {
            panic!("Proposer must hold at least 1000 governance tokens");
        }

        // Check if there's already an active proposal
        if let Some(existing_proposal) = env.storage().instance().get(&DataKey::PendingProposal) {
            if existing_proposal.status == ProposalStatus::Active {
                panic!("There is already an active proposal");
            }
        }

        // Create new proposal
        let proposal_counter: u32 = env.storage().instance().get(&DataKey::ProposalCounter).unwrap_or(0);
        let new_proposal_id = proposal_counter + 1;
        let current_ledger_time = env.ledger().timestamp();
        let deadline = current_ledger_time + PROPOSAL_VOTING_PERIOD;

        let proposal = FeeProposal {
            id: new_proposal_id,
            proposed_fee_bps: new_fee_bps,
            proposed_creator_share_bps: new_creator_share_bps,
            votes_for: 0,
            votes_against: 0,
            deadline,
            status: ProposalStatus::Active,
        };

        env.storage().instance().set(&DataKey::PendingProposal, &proposal);
        env.storage().instance().set(&DataKey::ProposalCounter, &new_proposal_id);

        new_proposal_id
    }

    pub fn vote(env: Env, voter: Address, proposal_id: u32, in_favor: bool) {
        voter.require_auth();

        let mut proposal: FeeProposal = env.storage().instance()
            .get(&DataKey::PendingProposal)
            .expect("No active proposal");

        if proposal.id != proposal_id {
            panic!("Proposal ID does not match active proposal");
        }

        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active for voting");
        }

        if env.ledger().timestamp() >= proposal.deadline {
            panic!("Voting period has ended");
        }

        // Check if voter has already voted
        let vote_key = DataKey::ProposalVotes(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            panic!("Already voted on this proposal");
        }

        // Get voter's token balance at time of vote
        let governance_token: Address = env.storage().instance().get(&DataKey::GovernanceToken).unwrap();
        let token_client = token::Client::new(&env, &governance_token);
        let vote_weight = token_client.balance(&voter);

        if vote_weight <= 0 {
            panic!("Voter must hold governance tokens");
        }

        // Record vote
        env.storage().persistent().set(&vote_key, &in_favor);

        // Update proposal vote counts
        if in_favor {
            proposal.votes_for += vote_weight;
        } else {
            proposal.votes_against += vote_weight;
        }

        env.storage().instance().set(&DataKey::PendingProposal, &proposal);
    }

    pub fn execute_proposal(env: Env, proposal_id: u32) {
        let mut proposal: FeeProposal = env.storage().instance()
            .get(&DataKey::PendingProposal)
            .expect("No active proposal");

        if proposal.id != proposal_id {
            panic!("Proposal ID does not match active proposal");
        }

        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }

        if env.ledger().timestamp() < proposal.deadline {
            panic!("Voting period has not ended");
        }

        // Check if proposal passed: votes_for > votes_against AND votes_for > 10% of total supply
        let total_votes = proposal.votes_for + proposal.votes_against;
        
        if proposal.votes_for > proposal.votes_against && proposal.votes_for >= QUORUM_THRESHOLD {
            // Proposal passed - update fees
            env.storage().instance().set(&DataKey::PlatformFeeBps, &proposal.proposed_fee_bps);
            env.storage().instance().set(&DataKey::CreatorShareBps, &proposal.proposed_creator_share_bps);
            proposal.status = ProposalStatus::Executed;
        } else {
            // Proposal failed
            proposal.status = ProposalStatus::Failed;
        }

        env.storage().instance().set(&DataKey::PendingProposal, &proposal);
    }

    pub fn admin_set_fee(env: Env, admin: Address, new_fee_bps: u32, new_creator_share_bps: u32) {
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            admin.require_auth();
        }

        env.storage().instance().set(&DataKey::PlatformFeeBps, &new_fee_bps);
        env.storage().instance().set(&DataKey::CreatorShareBps, &new_creator_share_bps);
    }

    pub fn get_vote_status(env: Env, proposal_id: u32, voter: Address) -> Option<bool> {
        let vote_key = DataKey::ProposalVotes(proposal_id, voter);
        env.storage().persistent().get(&vote_key)
    }
}
