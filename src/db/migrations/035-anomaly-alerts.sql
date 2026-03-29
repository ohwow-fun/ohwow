CREATE TABLE IF NOT EXISTS agent_workforce_anomaly_alerts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  expected_value REAL,
  actual_value REAL,
  z_score REAL,
  message TEXT,
  acknowledged INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_workspace ON agent_workforce_anomaly_alerts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_agent ON agent_workforce_anomaly_alerts(agent_id, created_at DESC);
