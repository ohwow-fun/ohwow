-- 103-fix-person-models-fk.sql
-- Migration 094 declared team_member_id as REFERENCES team_members(id) but
-- the real table is agent_workforce_team_members. With foreign_keys = ON
-- (set in db/init.ts) any INSERT/UPDATE on agent_workforce_person_models
-- fails with "no such table: main.team_members" because SQLite resolves
-- the FK target lazily, and the target does not exist.
--
-- SQLite has no ALTER TABLE DROP CONSTRAINT, so we rebuild the table:
-- rename the old one, CREATE the new shape with the correct FK, copy rows,
-- drop the rename. Wrapped in a transaction so either everything lands or
-- nothing does.
--
-- The new FK points at agent_workforce_team_members(id) with ON DELETE
-- SET NULL matching the original intent.

-- The migration runner already wraps each file in a transaction, so we
-- do not BEGIN/COMMIT ourselves. foreign_keys is set at init time; the
-- rebuild-via-rename pattern works here because we copy rows between
-- two tables in the same workspace and the only broken FK is the one
-- we are fixing.

ALTER TABLE agent_workforce_person_models RENAME TO agent_workforce_person_models_old;

CREATE TABLE agent_workforce_person_models (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES agent_workforce_workspaces(id) ON DELETE CASCADE,
  team_member_id TEXT REFERENCES agent_workforce_team_members(id) ON DELETE SET NULL,
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
  work_pattern_map TEXT DEFAULT '{}',
  collective_briefing TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO agent_workforce_person_models (
  id, workspace_id, team_member_id, name, email, avatar_url, role_title,
  variant, work_history, skills_map, domain_expertise, blind_spots,
  tool_proficiency, communication_style, energy_patterns, learning_style,
  collaboration_preferences, ambitions, values_and_motivations,
  friction_points, flow_triggers, skill_gaps_to_close, external_context,
  growth_arc, growth_velocity, growth_direction, growth_snapshots,
  ingestion_status, ingestion_variant, last_ingestion_at,
  observation_count, refinement_count, work_pattern_map, collective_briefing,
  created_at, updated_at
)
SELECT
  id, workspace_id, team_member_id, name, email, avatar_url, role_title,
  variant, work_history, skills_map, domain_expertise, blind_spots,
  tool_proficiency, communication_style, energy_patterns, learning_style,
  collaboration_preferences, ambitions, values_and_motivations,
  friction_points, flow_triggers, skill_gaps_to_close, external_context,
  growth_arc, growth_velocity, growth_direction, growth_snapshots,
  ingestion_status, ingestion_variant, last_ingestion_at,
  observation_count, refinement_count, work_pattern_map, collective_briefing,
  created_at, updated_at
FROM agent_workforce_person_models_old;

DROP TABLE agent_workforce_person_models_old;

CREATE INDEX IF NOT EXISTS idx_person_models_workspace
  ON agent_workforce_person_models(workspace_id);
