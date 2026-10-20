-- #1063 Validate embedded widget origins against an explicit campaign allowlist
--
-- Each campaign stores an ordered list of approved embed origins that is
-- checked on every embed-token and widget request.  An "origin" here is the
-- scheme + host (+ optional non-default port), e.g. "https://app.example.com"
-- or "http://localhost:3000".
--
-- Rationale for a dedicated table rather than an array column on campaigns:
--   • Ordered by created_at so the owner can see when each was added.
--   • Enables a clean per-row revoke without overwriting the whole array.
--   • Keeps the campaigns row narrow.

CREATE TABLE IF NOT EXISTS campaign_embed_allowed_origins (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  origin      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A campaign may register each normalised origin at most once.
  CONSTRAINT campaign_embed_allowed_origins_unique UNIQUE (campaign_id, origin)
);

CREATE INDEX IF NOT EXISTS idx_campaign_embed_origins_campaign
  ON campaign_embed_allowed_origins (campaign_id);

-- Back-fill: any existing embed_token rows that already have non-empty
-- allowed_origins JSONB get their entries promoted to the new table so they
-- are visible via the management API immediately.  No-op if the table was just
-- created and there are no pre-existing rows.
INSERT INTO campaign_embed_allowed_origins (campaign_id, origin)
SELECT DISTINCT
       et.campaign_id,
       lower(trim(trailing '/' from trim(o::text, '"'))) AS origin
  FROM embed_tokens et,
       jsonb_array_elements(et.allowed_origins) AS o
 WHERE jsonb_array_length(et.allowed_origins) > 0
   AND o::text NOT IN ('""', '"*"')
ON CONFLICT DO NOTHING;
