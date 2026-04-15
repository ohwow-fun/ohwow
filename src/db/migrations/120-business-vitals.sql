-- =====================================================================
-- Migration 120: business_vitals — time-series of operator business signals
--
-- Week-1 "Heart": give the homeostasis controller something to read when
-- deciding whether the runtime is producing more value than it costs.
-- Each row is one snapshot of the operator's business at time ts.
--
-- Columns are all nullable (except ts / source) so partial snapshots
-- land cleanly: a workspace with no Stripe key still accumulates
-- daily_cost_cents rows; a workspace with Stripe but no active-user
-- tracker still gets MRR.
--
-- Units:
--   mrr            — monthly recurring revenue, cents
--   arr            — annualized recurring revenue, cents (= mrr * 12 when
--                    not derived from a separate feed)
--   active_users   — count of distinct users active in the trailing window
--   daily_cost_cents — sum of agent_workforce_tasks.cost_cents for the
--                    local day of ts (UTC)
--   runway_days    — cash-on-hand / burn_rate when both are known
--   source         — producer of this row: "stripe", "manual", "import",
--                    "tasks_aggregate", etc. Never a business-specific
--                    name. New producers just add their own string.
-- =====================================================================

-- @statement
CREATE TABLE IF NOT EXISTS business_vitals (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  ts               TEXT NOT NULL DEFAULT (datetime('now')),
  mrr              INTEGER,
  arr              INTEGER,
  active_users     INTEGER,
  daily_cost_cents INTEGER,
  runway_days      REAL,
  source           TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_business_vitals_workspace_ts
  ON business_vitals(workspace_id, ts DESC);
-- @statement
CREATE INDEX IF NOT EXISTS idx_business_vitals_source
  ON business_vitals(source, ts DESC);
