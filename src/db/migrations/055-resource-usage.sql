-- Agent OS: Resource Usage Tracking

CREATE TABLE IF NOT EXISTS resource_usage_daily (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  date TEXT NOT NULL,
  concurrent_peak INTEGER DEFAULT 0,
  total_tasks INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_cost_cents INTEGER DEFAULT 0,
  UNIQUE(workspace_id, date)
);
