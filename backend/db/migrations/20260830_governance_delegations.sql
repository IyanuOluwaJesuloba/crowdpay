-- Governance vote delegation (#735)
--
-- Each wallet may delegate its governance voting power to another wallet.
-- A voter's effective weight is their own CROWD balance plus every balance
-- that delegates to them (directly or transitively). This table records the
-- single-target delegation edge. An empty responsibility (revocation) is
-- represented by a deleted row.
CREATE TABLE IF NOT EXISTS governance_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delegator_public_key TEXT NOT NULL,
  delegate_public_key  TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (delegator_public_key)
);

CREATE INDEX IF NOT EXISTS idx_governance_delegations_delegate
  ON governance_delegations(delegate_public_key);

CREATE INDEX IF NOT EXISTS idx_governance_delegations_delegator
  ON governance_delegations(delegator_public_key);