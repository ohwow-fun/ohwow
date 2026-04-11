-- Transition Engine: task patterns + task transitions (SQLite)

CREATE TABLE IF NOT EXISTS task_patterns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  person_model_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN (
    'email', 'content', 'research', 'data', 'social',
    'scheduling', 'crm', 'support', 'ops', 'general'
  )),
  detection_method TEXT NOT NULL DEFAULT 'auto_detected' CHECK (detection_method IN ('manual', 'auto_detected', 'pillar_derived')),
  frequency TEXT CHECK (frequency IN ('daily', 'weekly', 'biweekly', 'monthly', 'irregular')),
  avg_human_duration_minutes INTEGER,
  avg_agent_duration_minutes INTEGER,
  title_keywords TEXT DEFAULT '[]',
  tool_fingerprint TEXT DEFAULT '[]',
  department_id TEXT,
  preferred_agent_id TEXT,
  instance_count INTEGER DEFAULT 0,
  first_observed_at TEXT DEFAULT (datetime('now')),
  last_observed_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_transitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  person_model_id TEXT,
  current_stage INTEGER NOT NULL DEFAULT 1 CHECK (current_stage BETWEEN 1 AND 5),
  stage_history TEXT DEFAULT '[]',
  confidence_score REAL DEFAULT 0.0,
  correction_count INTEGER DEFAULT 0,
  total_instances INTEGER DEFAULT 0,
  successful_instances INTEGER DEFAULT 0,
  human_edit_rate REAL DEFAULT 1.0,
  last_promoted_at TEXT,
  last_demoted_at TEXT,
  time_saved_minutes INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_patterns_workspace ON task_patterns(workspace_id);
CREATE INDEX IF NOT EXISTS idx_task_patterns_person ON task_patterns(workspace_id, person_model_id);
CREATE INDEX IF NOT EXISTS idx_task_transitions_pattern ON task_transitions(pattern_id);
CREATE INDEX IF NOT EXISTS idx_task_transitions_workspace ON task_transitions(workspace_id);
