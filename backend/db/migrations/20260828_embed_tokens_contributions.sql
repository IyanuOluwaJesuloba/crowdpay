-- Migration: Embed tokens and embed contributions for Issue #455
CREATE TABLE IF NOT EXISTS embed_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    allowed_origins JSONB NOT NULL DEFAULT '[]'::jsonb,
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NULL,
    use_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_embed_tokens_campaign_id ON embed_tokens(campaign_id);
CREATE INDEX IF NOT EXISTS idx_embed_tokens_creator_id ON embed_tokens(creator_id);

CREATE TABLE IF NOT EXISTS embed_contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    embed_token_id UUID NOT NULL REFERENCES embed_tokens(id) ON DELETE CASCADE,
    amount NUMERIC(20, 7) NOT NULL,
    asset VARCHAR(12) NOT NULL,
    stellar_tx_hash VARCHAR(128) NULL,
    contributor_ip_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_embed_contributions_campaign_id ON embed_contributions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_embed_contributions_token_id ON embed_contributions(embed_token_id);
CREATE INDEX IF NOT EXISTS idx_embed_contributions_ip_hash_created ON embed_contributions(contributor_ip_hash, created_at);
