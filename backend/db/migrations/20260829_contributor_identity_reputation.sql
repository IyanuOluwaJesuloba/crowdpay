-- #689 Stellar DID Layer, Cross-Campaign Reputation Score & Privacy-Preserving KYC Attestations
--
-- New tables:
--   contributor_identities  — links a user to their on-chain DID
--   kyc_attestations        — privacy-preserving off-chain KYC records (hash only, never raw docs)
--   campaign_requirements   — per-campaign contribution gate (min reputation + required attestations)
--   reputation_events       — append-only audit log of every reputation delta

-- ---------------------------------------------------------------------------
-- contributor_identities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contributor_identities (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key              TEXT NOT NULL,
  did                     TEXT NOT NULL,
  contract_registered_at  TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contributor_identities_public_key_unique UNIQUE (public_key),
  CONSTRAINT contributor_identities_did_unique        UNIQUE (did),
  CONSTRAINT contributor_identities_user_id_unique    UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS contributor_identities_user_id_idx
  ON contributor_identities (user_id);

-- ---------------------------------------------------------------------------
-- kyc_attestations
-- Stores the off-chain record of a KYC-level attestation.
-- proof_hash is the SHA-256 of the Persona inquiry ID — never the document.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE kyc_attestation_type AS ENUM ('kyc_basic', 'kyc_standard', 'kyc_enhanced');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS kyc_attestations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key          TEXT NOT NULL,
  attestation_type    kyc_attestation_type NOT NULL,
  kyc_level           TEXT NOT NULL,
  persona_inquiry_id  TEXT,
  proof_hash          TEXT NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  on_chain_tx_hash    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kyc_attestations_user_id_idx
  ON kyc_attestations (user_id);
CREATE INDEX IF NOT EXISTS kyc_attestations_public_key_idx
  ON kyc_attestations (public_key);
CREATE INDEX IF NOT EXISTS kyc_attestations_active_idx
  ON kyc_attestations (user_id, attestation_type)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- campaign_requirements
-- One row per campaign; upsert on conflict to allow updates by the creator.
-- required_attestations is a JSONB array of attestation type strings,
-- e.g. ["kyc_basic", "kyc_standard"].
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_requirements (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id             UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  min_reputation_score    INTEGER NOT NULL DEFAULT 0
                            CHECK (min_reputation_score >= 0 AND min_reputation_score <= 1000),
  required_attestations   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_requirements_campaign_id_unique UNIQUE (campaign_id)
);

CREATE INDEX IF NOT EXISTS campaign_requirements_campaign_id_idx
  ON campaign_requirements (campaign_id);

-- ---------------------------------------------------------------------------
-- reputation_events
-- Immutable audit log — rows are never updated or deleted.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE reputation_event_type AS ENUM (
    'contribution_made',
    'contribution_to_successful_campaign',
    'contribution_to_failed_campaign',
    'dispute_raised_against_contributor'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS reputation_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key          TEXT NOT NULL,
  event_type          reputation_event_type NOT NULL,
  delta               INTEGER NOT NULL DEFAULT 0,
  resulting_score     INTEGER NOT NULL DEFAULT 0
                        CHECK (resulting_score >= 0 AND resulting_score <= 1000),
  related_campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  on_chain_tx_hash    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reputation_events_public_key_idx
  ON reputation_events (public_key);
CREATE INDEX IF NOT EXISTS reputation_events_public_key_created_idx
  ON reputation_events (public_key, created_at DESC);
CREATE INDEX IF NOT EXISTS reputation_events_campaign_idx
  ON reputation_events (related_campaign_id)
  WHERE related_campaign_id IS NOT NULL;
