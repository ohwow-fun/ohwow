-- 010-local-crm.sql
-- Local CRM tables for data sovereignty

CREATE TABLE IF NOT EXISTS agent_workforce_contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  contact_type TEXT NOT NULL DEFAULT 'lead' CHECK (contact_type IN ('lead', 'customer', 'partner', 'other')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tags TEXT DEFAULT '[]',
  custom_fields TEXT DEFAULT '{}',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_workspace ON agent_workforce_contacts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_contacts_type ON agent_workforce_contacts(workspace_id, contact_type);

CREATE TABLE IF NOT EXISTS agent_workforce_revenue_entries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
  year INTEGER NOT NULL CHECK (year >= 2000 AND year <= 2100),
  source TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_revenue_workspace ON agent_workforce_revenue_entries(workspace_id);
