-- CrowdPay PostgreSQL schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kyc_status') THEN
    CREATE TYPE kyc_status AS ENUM ('unverified', 'pending', 'verified', 'rejected');
  END IF;
END $$;

CREATE TABLE users (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                   TEXT UNIQUE NOT NULL,
  password_hash           TEXT NOT NULL,
  name                    TEXT NOT NULL,
  wallet_public_key       TEXT UNIQUE NOT NULL,
  wallet_secret_encrypted TEXT NOT NULL,
  role                    TEXT NOT NULL DEFAULT 'contributor'
                          CHECK (role IN ('contributor', 'creator', 'admin')),
  kyc_status              kyc_status NOT NULL DEFAULT 'unverified',
  kyc_provider_reference  TEXT,
  kyc_completed_at        TIMESTAMPTZ,
  is_admin                BOOLEAN DEFAULT FALSE,
  totp_secret             TEXT,
  totp_enabled            BOOLEAN DEFAULT FALSE,
  backup_codes            TEXT[],
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE campaigns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id          UUID NOT NULL REFERENCES users(id),
  title               TEXT NOT NULL,
  description         TEXT,
  target_amount       NUMERIC(20, 7) NOT NULL,
  raised_amount       NUMERIC(20, 7) NOT NULL DEFAULT 0,
  asset_type          TEXT NOT NULL CHECK (asset_type IN ('XLM', 'USDC')),
  wallet_public_key   TEXT UNIQUE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'funded', 'in_progress', 'completed', 'closed', 'withdrawn', 'failed', 'suspended')),
  deadline            DATE,
  show_backer_amounts BOOLEAN DEFAULT TRUE,
  category            TEXT CHECK (category IN (
                        'technology', 'community', 'arts', 'education',
                        'environment', 'health', 'business', 'open_source', 'other'
                      )),
  min_contribution    NUMERIC(20, 7),
  max_contribution    NUMERIC(20, 7),
  max_per_user        NUMERIC(20, 7),
  featured            BOOLEAN DEFAULT FALSE,
  featured_at         TIMESTAMPTZ,
  featured_note       TEXT,
  content_fingerprint TEXT,
  is_flagged_duplicate BOOLEAN DEFAULT FALSE,
  is_flagged_fraud    BOOLEAN DEFAULT FALSE,
  fraud_score         INTEGER DEFAULT 0,
  fraud_signals       JSONB DEFAULT '{}'::jsonb,
  share_count         INTEGER NOT NULL DEFAULT 0,
  country             TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS campaign_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL CONSTRAINT campaign_updates_body_length CHECK (char_length(body) <= 5000),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_updates_campaign_created_idx
  ON campaign_updates (campaign_id, created_at DESC);

CREATE TABLE contributions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES campaigns(id),
  sender_public_key   TEXT NOT NULL,
  amount              NUMERIC(20, 7) NOT NULL,
  asset               TEXT NOT NULL,
  anchor_id           TEXT,
  anchor_transaction_id TEXT,
  anchor_asset        TEXT,
  anchor_amount       NUMERIC(20, 7),
  payment_type        TEXT NOT NULL DEFAULT 'payment'
                        CHECK (payment_type IN ('payment', 'path_payment_strict_receive')),
  source_amount       NUMERIC(20, 7),
  source_asset        TEXT,
  conversion_rate     NUMERIC(30, 15),
  path                JSONB,
  tx_hash             TEXT UNIQUE NOT NULL,  -- deduplicate by Stellar transaction hash
  display_name        VARCHAR(50),
  refunded            BOOLEAN NOT NULL DEFAULT FALSE,
  platform_fee_amount NUMERIC(20, 7),
  ip_address          TEXT,
  device_fingerprint  TEXT,   -- salted HMAC of client device fingerprint (never raw)
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Withdrawal requests: require both creator + platform signature
CREATE TABLE withdrawal_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES campaigns(id),
  requested_by        UUID NOT NULL REFERENCES users(id),
  amount              NUMERIC(20, 7) NOT NULL,
  destination_key     TEXT NOT NULL,
  unsigned_xdr        TEXT NOT NULL,  -- transaction XDR waiting for signatures
  creator_signed      BOOLEAN DEFAULT FALSE,
  platform_signed     BOOLEAN DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'submitted', 'failed', 'denied')),
  denial_reason       TEXT,
  tx_hash             TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE withdrawal_approval_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_request_id   UUID NOT NULL REFERENCES withdrawal_requests(id) ON DELETE CASCADE,
  actor_user_id           UUID REFERENCES users(id),
  action                  TEXT NOT NULL CHECK (action IN (
                            'requested',
                            'creator_signed',
                            'platform_signed',
                            'creator_cancelled',
                            'platform_rejected',
                            'submit_failed'
                          )),
  note                    TEXT,
  metadata                JSONB,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE platform_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 
  message TEXT NOT NULL CHECK (length(trim(message)) > 0),
  severity                VARCHAR(20) NOT NULL DEFAULT 'info'
                            CHECK (severity IN ('info', 'warning', 'critical')),

  details_url             TEXT,
  active_from             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_until            TIMESTAMPTZ,
  deactivated_at          TIMESTAMPTZ,
  created_by              UUID NOT NULL
                            REFERENCES users(id)
                            ON DELETE RESTRICT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
  CHECK (
    active_until IS NULL
    OR active_until > active_from
  ),
  
  CHECK (
    deactivated_at IS NULL
    OR deactivated_at >= active_from
  )
);

-- Indexes

CREATE INDEX idx_announcements_active_period ON platform_announcements (active_from, active_until);
CREATE INDEX idx_announcements_created_by ON platform_announcements (created_by);
CREATE INDEX idx_announcements_current ON platform_announcements (active_from DESC)
  WHERE deactivated_at IS NULL;

CREATE INDEX ON contributions (campaign_id);
CREATE INDEX idx_contributions_campaign_unrefunded
  ON contributions (campaign_id)
  WHERE refunded = FALSE;
CREATE INDEX ON contributions (tx_hash);
CREATE UNIQUE INDEX contributions_anchor_transaction_idx
  ON contributions (anchor_id, anchor_transaction_id)
  WHERE anchor_transaction_id IS NOT NULL;
CREATE INDEX ON campaigns (status);
CREATE INDEX ON campaigns (creator_id);
CREATE INDEX ON campaigns (category);
CREATE INDEX ON campaigns (featured) WHERE featured = TRUE;
CREATE UNIQUE INDEX users_kyc_provider_reference_idx
  ON users (kyc_provider_reference)
  WHERE kyc_provider_reference IS NOT NULL;
CREATE INDEX ON withdrawal_approval_events (withdrawal_request_id);
CREATE INDEX ON withdrawal_approval_events (created_at DESC);

-- Unified on-chain audit + reporting index for Stellar flows (contributions, withdrawals)
CREATE TABLE stellar_transactions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    TEXT NOT NULL CHECK (kind IN ('contribution', 'withdrawal')),
  status                  TEXT NOT NULL CHECK (status IN (
                            'pending_signatures',
                            'submitted',
                            'indexed',
                            'failed'
                          )),
  tx_hash                 TEXT UNIQUE,
  campaign_id             UUID NOT NULL REFERENCES campaigns(id),
  withdrawal_request_id   UUID REFERENCES withdrawal_requests(id),
  initiated_by_user_id    UUID REFERENCES users(id),
  unsigned_xdr            TEXT,
  signed_xdr              TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  contribution_id         UUID REFERENCES contributions(id),
  failure_reason          TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT stellar_transactions_kind_withdrawal_chk CHECK (
    (kind = 'withdrawal' AND withdrawal_request_id IS NOT NULL)
    OR (kind = 'contribution' AND withdrawal_request_id IS NULL)
  ),
  CONSTRAINT stellar_transactions_withdrawal_no_contribution_chk CHECK (
    (kind = 'withdrawal' AND contribution_id IS NULL)
    OR kind = 'contribution'
  )
);

CREATE INDEX stellar_transactions_campaign_created_idx
  ON stellar_transactions (campaign_id, created_at DESC);
CREATE INDEX stellar_transactions_status_idx ON stellar_transactions (status);
CREATE INDEX stellar_transactions_tx_hash_idx ON stellar_transactions (tx_hash);
CREATE INDEX stellar_transactions_withdrawal_idx ON stellar_transactions (withdrawal_request_id);

-- Integrations: API keys (server-to-server) and outbound webhooks
CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_prefix      TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL DEFAULT '',
  scopes          TEXT[] NOT NULL DEFAULT ARRAY['read', 'write', 'withdrawals'],
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX api_keys_user_active_idx ON api_keys (user_id) WHERE revoked_at IS NULL;

CREATE TABLE webhooks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  events          TEXT[] NOT NULL,
  secret          TEXT NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX webhooks_user_active_idx ON webhooks (user_id) WHERE revoked_at IS NULL;

CREATE TABLE webhook_deliveries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id            UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type            TEXT NOT NULL,
  payload               JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'retrying')),
  response_status       INT,
  response_body_snippet TEXT,
  attempt_count         INT NOT NULL DEFAULT 0,
  last_error            TEXT,
  next_retry_at         TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id);
CREATE INDEX webhook_deliveries_retry_idx
  ON webhook_deliveries (status, next_retry_at)
  WHERE status IN ('pending', 'retrying');

CREATE TABLE milestones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  release_percentage NUMERIC(7, 4) NOT NULL CHECK (release_percentage > 0 AND release_percentage <= 100),
  sort_order      INT NOT NULL DEFAULT 0,
  evidence_url    TEXT,
  evidence_description TEXT,
  evidence_submitted_at TIMESTAMPTZ,
  destination_key TEXT,
  review_note     TEXT,
  reviewer_id     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'pending_review', 'rejected', 'approved', 'released')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  released_at     TIMESTAMPTZ,
  claimed_at      TIMESTAMPTZ
);

CREATE INDEX milestones_campaign_idx ON milestones (campaign_id);

CREATE TABLE milestone_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  actor_id     UUID REFERENCES users(id),
  action       TEXT NOT NULL,
  note         TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX milestone_events_milestone_idx ON milestone_events (milestone_id, created_at ASC);
ALTER TABLE withdrawal_requests
  ADD COLUMN milestone_id UUID REFERENCES milestones(id);

CREATE INDEX withdrawal_requests_milestone_idx ON withdrawal_requests (milestone_id);

CREATE TABLE anchor_deposits (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id                 UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  anchor_id                   TEXT NOT NULL,
  anchor_transaction_id       TEXT NOT NULL,
  anchor_asset                TEXT NOT NULL,
  anchor_amount               NUMERIC(20, 7) NOT NULL,
  campaign_asset              TEXT NOT NULL,
  contribution_amount         NUMERIC(20, 7) NOT NULL,
  contribution_flow           JSONB NOT NULL DEFAULT '{}',
  conversion_quote            JSONB,
  interactive_url             TEXT NOT NULL,
  anchor_auth_token           TEXT,
  anchor_auth_expires_at      TIMESTAMPTZ,
  status                      TEXT NOT NULL DEFAULT 'pending_anchor'
                                CHECK (status IN (
                                  'pending_anchor',
                                  'deposit_completed',
                                  'contribution_submitted',
                                  'completed',
                                  'failed'
                                )),
  last_anchor_status          TEXT,
  last_anchor_payload         JSONB,
  last_error                  TEXT,
  contribution_tx_hash        TEXT,
  contribution_stellar_transaction_id UUID REFERENCES stellar_transactions(id),
  contribution_id             UUID REFERENCES contributions(id),
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW(),
  completed_at                TIMESTAMPTZ
);

CREATE UNIQUE INDEX anchor_deposits_anchor_tx_idx
  ON anchor_deposits (anchor_id, anchor_transaction_id);
CREATE INDEX anchor_deposits_user_created_idx
  ON anchor_deposits (user_id, created_at DESC);
CREATE INDEX anchor_deposits_campaign_created_idx
  ON anchor_deposits (campaign_id, created_at DESC);



CREATE TABLE password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);
CREATE INDEX password_reset_tokens_expires_idx ON password_reset_tokens (expires_at);

-- Horizon paging cursor per campaign wallet (survives restarts; enables replay + stream resume)
CREATE TABLE ledger_stream_cursors (
  campaign_id         UUID PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  wallet_public_key   TEXT NOT NULL,
  last_cursor         TEXT NOT NULL,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ledger_stream_cursors_wallet_idx ON ledger_stream_cursors (wallet_public_key);

-- Refresh tokens for JWT session management
CREATE TABLE refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX refresh_tokens_user_active_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_token_hash_idx ON refresh_tokens (token_hash);

-- Referral tracking per campaign contributor
CREATE TABLE campaign_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  referrer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referral_code TEXT NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 0,
  contribution_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_campaign_referrals_campaign_id ON campaign_referrals(campaign_id);
CREATE UNIQUE INDEX idx_campaign_referrals_code ON campaign_referrals(referral_code);
CREATE UNIQUE INDEX idx_campaign_referrals_user_campaign ON campaign_referrals(campaign_id, referrer_user_id);

-- Feature flags for gradual rollouts, A/B tests, and kill switches
CREATE TABLE feature_flags (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT UNIQUE NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  enabled           BOOLEAN NOT NULL DEFAULT false,
  rollout_pct       INTEGER CHECK (rollout_pct >= 0 AND rollout_pct <= 100),
  target_roles      TEXT[],
  target_user_ids   UUID[],
  variants          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX feature_flags_name_idx ON feature_flags (name);
CREATE INDEX feature_flags_enabled_idx ON feature_flags (enabled) WHERE enabled = true;

-- Failed payment records for ledger monitor retry/dead-letter
CREATE TABLE failed_payment_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  wallet_public_key TEXT NOT NULL,
  payment_record    JSONB NOT NULL,
  error_message     TEXT,
  retry_count       INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX failed_payment_records_tx_campaign_idx
  ON failed_payment_records ((payment_record->>'transaction_hash'), campaign_id);

-- Embed tokens for public campaign embeds (Issue #455)
CREATE TABLE embed_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  allowed_origins JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NULL,
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_embed_tokens_campaign_id ON embed_tokens(campaign_id);
CREATE INDEX idx_embed_tokens_creator_id ON embed_tokens(creator_id);

CREATE TABLE embed_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  embed_token_id UUID NOT NULL REFERENCES embed_tokens(id) ON DELETE CASCADE,
  amount NUMERIC(20, 7) NOT NULL,
  asset VARCHAR(12) NOT NULL,
  stellar_tx_hash VARCHAR(128) NULL,
  contributor_ip_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_embed_contributions_campaign_id ON embed_contributions(campaign_id);
CREATE INDEX idx_embed_contributions_token_id ON embed_contributions(embed_token_id);
CREATE INDEX idx_embed_contributions_ip_hash_created ON embed_contributions(contributor_ip_hash, created_at);

