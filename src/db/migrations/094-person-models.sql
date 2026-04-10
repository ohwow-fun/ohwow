-- Person Models: deep understanding of each human in the workspace

CREATE TABLE IF NOT EXISTS agent_workforce_person_models (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES agent_workforce_workspaces(id) ON DELETE CASCADE,
  team_member_id TEXT REFERENCES team_members(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  role_title TEXT,
  variant TEXT NOT NULL DEFAULT 'team_member' CHECK (variant IN ('founder', 'team_member', 'new_hire')),
  work_history TEXT DEFAULT '[]',
  skills_map TEXT DEFAULT '{}',
  domain_expertise TEXT DEFAULT '{}',
  blind_spots TEXT DEFAULT '[]',
  tool_proficiency TEXT DEFAULT '{}',
  communication_style TEXT DEFAULT '{}',
  energy_patterns TEXT DEFAULT '{}',
  learning_style TEXT,
  collaboration_preferences TEXT DEFAULT '{}',
  ambitions TEXT DEFAULT '{}',
  values_and_motivations TEXT DEFAULT '[]',
  friction_points TEXT DEFAULT '[]',
  flow_triggers TEXT DEFAULT '[]',
  skill_gaps_to_close TEXT DEFAULT '[]',
  external_context TEXT DEFAULT '{}',
  growth_arc TEXT DEFAULT '{}',
  growth_velocity REAL DEFAULT 0,
  growth_direction TEXT DEFAULT 'ascending' CHECK (growth_direction IN ('ascending', 'plateau', 'declining', 'transforming')),
  growth_snapshots TEXT DEFAULT '[]',
  ingestion_status TEXT DEFAULT 'not_started' CHECK (ingestion_status IN ('not_started', 'in_progress', 'initial_complete', 'mature')),
  ingestion_variant TEXT,
  last_ingestion_at TEXT,
  observation_count INTEGER DEFAULT 0,
  refinement_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_workforce_person_observations (
  id TEXT PRIMARY KEY,
  person_model_id TEXT NOT NULL REFERENCES agent_workforce_person_models(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES agent_workforce_workspaces(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  observation_type TEXT NOT NULL CHECK (observation_type IN (
    'task_outcome', 'communication', 'feedback', 'self_report', 'behavioral', 'peer_observation', 'correction'
  )),
  content TEXT NOT NULL,
  data TEXT DEFAULT '{}',
  confidence REAL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  processed INTEGER DEFAULT 0,
  source_type TEXT,
  source_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_person_models_workspace ON agent_workforce_person_models(workspace_id);
CREATE INDEX IF NOT EXISTS idx_person_observations_model ON agent_workforce_person_observations(person_model_id);
