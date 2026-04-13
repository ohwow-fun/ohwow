-- Code skills: add columns that let the synthesis pipeline store
-- deterministic TypeScript-backed skills alongside the existing
-- procedure/judgement/extraction/verification skill_types.
--
-- Local SQLite has no CHECK constraint on skill_type, so adding a new
-- value ('code') is a no-op at the schema level. The new columns are
-- all nullable or default-initialized so existing rows remain valid.
--
-- Mirror migration lives at ohwow.fun/sql/359-code-skills.sql.

ALTER TABLE agent_workforce_skills ADD COLUMN script_path TEXT;
ALTER TABLE agent_workforce_skills ADD COLUMN selectors TEXT DEFAULT '{}';
ALTER TABLE agent_workforce_skills ADD COLUMN origin_trace_id TEXT;
ALTER TABLE agent_workforce_skills ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_workforce_skills ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_workforce_skills ADD COLUMN promoted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_skills_script_path
  ON agent_workforce_skills(script_path)
  WHERE script_path IS NOT NULL;
