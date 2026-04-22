-- Infrastructure bill tracker (Layer 2 Financial Autonomy).
-- Operators register recurring infrastructure costs and confirm them
-- periodically. The eternal SLA watcher surfaces unconfirmed bills.
CREATE TABLE IF NOT EXISTS infrastructure_bills (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id  TEXT NOT NULL,
  service_name  TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'hosting'
                CHECK (category IN ('hosting','domain','saas','payment','other')),
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  billing_cycle TEXT NOT NULL DEFAULT 'monthly'
                CHECK (billing_cycle IN ('monthly','annual','one-time')),
  auto_pay      INTEGER NOT NULL DEFAULT 0,
  last_confirmed_at TEXT,
  notes         TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_infra_bills_workspace
  ON infrastructure_bills(workspace_id);
