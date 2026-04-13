-- 104-fix-person-observations-fk.sql
--
-- Migration 103 rebuilt agent_workforce_person_models with the correct FK
-- target (agent_workforce_team_members), via the RENAME + CREATE + INSERT +
-- DROP dance. But the child table agent_workforce_person_observations
-- declares its FK as:
--   person_model_id TEXT NOT NULL REFERENCES "agent_workforce_person_models_old"(id) ON DELETE CASCADE
-- SQLite baked the rename target into the observations FK at the moment of
-- RENAME, and now observations point at a dropped table. Any insert fails
-- with "no such table: main.agent_workforce_person_models_old" because
-- foreign_keys is on in db/init.ts.
--
-- Rebuild the observations table too so the FK points back at
-- agent_workforce_person_models(id). Same copy-via-rename pattern as 103.
-- The CHECK and indexes are recreated to match.

ALTER TABLE agent_workforce_person_observations RENAME TO agent_workforce_person_observations_old;

CREATE TABLE agent_workforce_person_observations (
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

INSERT INTO agent_workforce_person_observations (
  id, person_model_id, workspace_id, dimension, observation_type, content,
  data, confidence, processed, source_type, source_id, created_at
)
SELECT
  id, person_model_id, workspace_id, dimension, observation_type, content,
  data, confidence, processed, source_type, source_id, created_at
FROM agent_workforce_person_observations_old;

DROP TABLE agent_workforce_person_observations_old;

CREATE INDEX IF NOT EXISTS idx_person_observations_model
  ON agent_workforce_person_observations(person_model_id);
