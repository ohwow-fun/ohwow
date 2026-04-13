-- 105-onboarding-plans.sql
--
-- First-class onboarding plan artifact per team member. The COS agent
-- generates a 4-week ramp plan during person-model ingestion via
-- propose_first_month_plan, and that draft lives here until the member
-- (via the chat) accepts it — at which point accept_onboarding_plan
-- materializes it into real agent_workforce_tasks + agent_workforce_goals
-- rows and flips status to 'accepted'.
--
-- Shape:
--
--   weeks: JSON array, one entry per week:
--     [
--       {
--         "week": 1,
--         "theme": "Land + observe",
--         "tasks": [
--           { "title": ..., "description": ..., "owner": "member|guide|<agent-id>",
--             "success_criteria": ..., "materialized_task_id": null }
--         ]
--       },
--       ...
--     ]
--
--   status:
--     'draft'        — freshly proposed, member hasn't reviewed yet
--     'accepted'     — member accepted, tasks + goals created
--     'in_progress'  — at least one materialized task has been started
--     'completed'    — all materialized tasks are done
--     'archived'     — superseded or canceled

CREATE TABLE IF NOT EXISTS agent_workforce_onboarding_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES agent_workforce_workspaces(id) ON DELETE CASCADE,
  team_member_id TEXT NOT NULL REFERENCES agent_workforce_team_members(id) ON DELETE CASCADE,
  person_model_id TEXT REFERENCES agent_workforce_person_models(id) ON DELETE SET NULL,
  created_by_agent_id TEXT REFERENCES agent_workforce_agents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'accepted', 'in_progress', 'completed', 'archived')),
  rationale TEXT,
  closing_question TEXT,
  weeks TEXT NOT NULL DEFAULT '[]',
  model_used TEXT,
  provider TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  accepted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_onboarding_plans_member
  ON agent_workforce_onboarding_plans(team_member_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_onboarding_plans_workspace_status
  ON agent_workforce_onboarding_plans(workspace_id, status);
