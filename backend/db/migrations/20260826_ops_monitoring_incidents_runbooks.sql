-- Ops metrics, incident tracking, and automated runbook executions

CREATE TABLE IF NOT EXISTS ops_metrics (
  id BIGSERIAL PRIMARY KEY,
  collected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metric_name VARCHAR(120) NOT NULL,
  metric_value NUMERIC NOT NULL,
  metric_labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  threshold_breached BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_ops_metrics_name_time ON ops_metrics (metric_name, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_metrics_collected_at ON ops_metrics (collected_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('warning', 'critical')),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  triggered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  resolved_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  triggering_metric_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  notification_sent BOOLEAN NOT NULL DEFAULT FALSE,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents (status);
CREATE INDEX IF NOT EXISTS idx_incidents_type_status ON incidents (incident_type, status);
CREATE INDEX IF NOT EXISTS idx_incidents_triggered_at ON incidents (triggered_at DESC);

CREATE TABLE IF NOT EXISTS runbook_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID REFERENCES incidents(id) ON DELETE SET NULL,
  runbook_type VARCHAR(100) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'requires_manual_action', 'failed')),
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_runbook_executions_incident_id ON runbook_executions (incident_id);
CREATE INDEX IF NOT EXISTS idx_runbook_executions_started_at ON runbook_executions (started_at DESC);
