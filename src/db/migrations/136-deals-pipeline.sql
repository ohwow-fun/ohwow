-- Deal pipeline stages (customizable per workspace)
-- @statement
CREATE TABLE IF NOT EXISTS deal_stages (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  name             TEXT NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  probability      REAL NOT NULL DEFAULT 0.0,
  is_won           INTEGER NOT NULL DEFAULT 0,
  is_lost          INTEGER NOT NULL DEFAULT 0,
  color            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_deal_stages_workspace ON deal_stages(workspace_id, sort_order);

-- Deals
-- @statement
CREATE TABLE IF NOT EXISTS deals (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  contact_id       TEXT REFERENCES agent_workforce_contacts(id),
  title            TEXT NOT NULL,
  value_cents      INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  stage_id         TEXT REFERENCES deal_stages(id),
  stage_name       TEXT,
  probability      REAL,
  expected_close   TEXT,
  actual_close     TEXT,
  owner_id         TEXT,
  source           TEXT,
  notes            TEXT,
  custom_fields    TEXT DEFAULT '{}',
  lost_reason      TEXT,
  won_at           TEXT,
  lost_at          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_deals_workspace ON deals(workspace_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_deals_contact ON deals(contact_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(workspace_id, stage_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_deals_expected_close ON deals(workspace_id, expected_close);

-- Deal activity log
-- @statement
CREATE TABLE IF NOT EXISTS deal_activities (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  deal_id          TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  activity_type    TEXT NOT NULL,
  from_value       TEXT,
  to_value         TEXT,
  note             TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_deal_activities_deal ON deal_activities(deal_id, created_at DESC);
