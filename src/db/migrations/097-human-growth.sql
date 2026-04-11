-- Human Growth Engine: skill progression, growth milestones, delegation tracking
-- Phase 4 of Center of Operations

-- Skill progression: tracks skill level changes over time per person
CREATE TABLE IF NOT EXISTS skill_progression (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  person_model_id TEXT NOT NULL REFERENCES agent_workforce_person_models(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  previous_level REAL DEFAULT 0.0,
  new_level REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'task_outcome' CHECK (source IN (
    'task_outcome', 'self_assessment', 'peer_observation', 'training', 'routing_feedback'
  )),
  task_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Growth milestones: target achievements on skill development paths
CREATE TABLE IF NOT EXISTS growth_milestones (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  person_model_id TEXT NOT NULL REFERENCES agent_workforce_person_models(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  target_level REAL NOT NULL DEFAULT 0.7,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'achieved', 'abandoned')),
  difficulty TEXT NOT NULL DEFAULT 'intermediate' CHECK (difficulty IN ('beginner', 'intermediate', 'advanced', 'expert')),
  suggested_tasks TEXT DEFAULT '[]',
  scaffolding_level TEXT NOT NULL DEFAULT 'high' CHECK (scaffolding_level IN ('high', 'medium', 'low', 'none')),
  path_order INTEGER DEFAULT 0,
  achieved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Delegation decisions: founder-specific tracking of what gets delegated
CREATE TABLE IF NOT EXISTS delegation_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  person_model_id TEXT NOT NULL REFERENCES agent_workforce_person_models(id) ON DELETE CASCADE,
  decision_type TEXT NOT NULL,
  description TEXT,
  delegated_to_type TEXT CHECK (delegated_to_type IN ('agent', 'person')),
  delegated_to_id TEXT,
  outcome TEXT DEFAULT 'pending' CHECK (outcome IN ('successful', 'reverted', 'pending')),
  founder_review_needed INTEGER NOT NULL DEFAULT 1,
  routing_decision_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skill_progression_person ON skill_progression(person_model_id);
CREATE INDEX IF NOT EXISTS idx_skill_progression_skill ON skill_progression(person_model_id, skill_name);
CREATE INDEX IF NOT EXISTS idx_growth_milestones_person ON growth_milestones(person_model_id);
CREATE INDEX IF NOT EXISTS idx_growth_milestones_status ON growth_milestones(person_model_id, status);
CREATE INDEX IF NOT EXISTS idx_delegation_decisions_person ON delegation_decisions(person_model_id);
CREATE INDEX IF NOT EXISTS idx_delegation_decisions_workspace ON delegation_decisions(workspace_id);
