-- Recurring automated billing enhancements (#738)
--
-- Track charge attempts so the monthly cron can apply exponential backoff on
-- transient Stellar failures instead of silently dropping or hammering the
-- network. Every schedule stays active until the donor cancels it; a failing
-- schedule simply re-runs with a growing delay.
ALTER TABLE recurring_contributions
  ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE recurring_contributions
  ADD COLUMN IF NOT EXISTS last_error TEXT;