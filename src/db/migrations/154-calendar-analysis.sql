-- @statement
CREATE TABLE IF NOT EXISTS calendar_analysis_snapshots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  snapshot_date TEXT NOT NULL,
  business_id TEXT,
  total_hours_scheduled REAL DEFAULT 0,
  focus_hours REAL DEFAULT 0,
  meeting_hours REAL DEFAULT 0,
  analysis_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_cal_analysis_business_date ON calendar_analysis_snapshots(business_id, snapshot_date DESC);
