-- Work Router: intelligent task routing + work augmentation + notification prefs
-- Phase 3 of Center of Operations

-- Routing decisions: tracks how tasks are assigned and why
CREATE TABLE IF NOT EXISTS work_routing_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  task_title TEXT NOT NULL,
  task_urgency TEXT DEFAULT 'normal' CHECK (task_urgency IN ('low', 'normal', 'high', 'critical')),
  required_skills TEXT DEFAULT '[]',
  estimated_effort_minutes INTEGER,

  -- Assignment
  assigned_to_type TEXT NOT NULL CHECK (assigned_to_type IN ('person', 'agent')),
  assigned_to_id TEXT NOT NULL,
  assignment_method TEXT NOT NULL DEFAULT 'recommended' CHECK (assignment_method IN ('auto', 'recommended', 'manual', 'fallback')),
  confidence_score REAL DEFAULT 0.0 CHECK (confidence_score >= 0 AND confidence_score <= 1),

  -- Scoring breakdown (JSON: { skill: 0.9, capacity: 0.7, energy: 0.8, ... })
  score_breakdown TEXT DEFAULT '{}',
  runner_up_id TEXT,
  runner_up_type TEXT CHECK (runner_up_type IN ('person', 'agent')),
  runner_up_score REAL,

  -- Outcome tracking
  outcome TEXT CHECK (outcome IN ('completed', 'reassigned', 'rejected', 'timed_out')),
  outcome_quality_score REAL CHECK (outcome_quality_score >= 0 AND outcome_quality_score <= 1),
  actual_effort_minutes INTEGER,
  completed_at TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Work augmentation: pre/co/post work for human-assigned tasks
CREATE TABLE IF NOT EXISTS work_augmentations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  routing_decision_id TEXT REFERENCES work_routing_decisions(id) ON DELETE CASCADE,
  task_id TEXT,
  person_model_id TEXT,

  -- Phase
  phase TEXT NOT NULL CHECK (phase IN ('pre', 'co', 'post')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'skipped', 'failed')),

  -- What the augmentation does
  augmentation_type TEXT NOT NULL,
  description TEXT,
  agent_id TEXT,

  -- Output
  output TEXT DEFAULT '{}',
  was_useful INTEGER,

  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Notification preferences per person (extends person model)
CREATE TABLE IF NOT EXISTS notification_preferences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  person_model_id TEXT NOT NULL,

  -- Channel preferences
  preferred_channel TEXT DEFAULT 'in_app' CHECK (preferred_channel IN ('in_app', 'email', 'slack', 'telegram', 'whatsapp')),
  fallback_channel TEXT DEFAULT 'email' CHECK (fallback_channel IN ('in_app', 'email', 'slack', 'telegram', 'whatsapp')),

  -- Deep work protection
  deep_work_start TEXT,
  deep_work_end TEXT,
  deep_work_days TEXT DEFAULT '[]',
  buffer_during_deep_work INTEGER NOT NULL DEFAULT 1,

  -- Energy-aware filtering
  low_energy_start TEXT,
  low_energy_end TEXT,
  suppress_complex_during_low_energy INTEGER NOT NULL DEFAULT 1,

  -- Urgency thresholds
  min_urgency_for_interrupt TEXT DEFAULT 'high' CHECK (min_urgency_for_interrupt IN ('low', 'normal', 'high', 'critical')),

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routing_decisions_workspace ON work_routing_decisions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_routing_decisions_assignee ON work_routing_decisions(assigned_to_type, assigned_to_id);
CREATE INDEX IF NOT EXISTS idx_routing_decisions_task ON work_routing_decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_augmentations_routing ON work_augmentations(routing_decision_id);
CREATE INDEX IF NOT EXISTS idx_augmentations_workspace ON work_augmentations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_notification_prefs_person ON notification_preferences(person_model_id);
