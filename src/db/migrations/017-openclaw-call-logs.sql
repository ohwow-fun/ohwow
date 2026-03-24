-- OpenClaw skill call audit log
CREATE TABLE IF NOT EXISTS openclaw_call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_openclaw_call_logs_skill ON openclaw_call_logs(skill_id);
CREATE INDEX IF NOT EXISTS idx_openclaw_call_logs_timestamp ON openclaw_call_logs(timestamp);
