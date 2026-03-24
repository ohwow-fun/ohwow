-- Custom webhook support for local triggers
-- Adds per-trigger webhook URLs, sample payload storage, and field discovery

ALTER TABLE local_triggers ADD COLUMN webhook_token TEXT;
ALTER TABLE local_triggers ADD COLUMN sample_payload TEXT;
ALTER TABLE local_triggers ADD COLUMN sample_fields TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_triggers_webhook_token
  ON local_triggers(webhook_token) WHERE webhook_token IS NOT NULL;
