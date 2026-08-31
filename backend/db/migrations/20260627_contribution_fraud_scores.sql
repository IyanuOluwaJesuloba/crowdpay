CREATE TABLE IF NOT EXISTS contribution_fraud_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id UUID NOT NULL UNIQUE,
  campaign_id UUID NOT NULL,
  user_id UUID,
  score INTEGER NOT NULL,
  breakdown JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'approved',
  resolved_by UUID,
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contribution_fraud_scores_status ON contribution_fraud_scores(status);
CREATE INDEX IF NOT EXISTS idx_contribution_fraud_scores_campaign ON contribution_fraud_scores(campaign_id);
