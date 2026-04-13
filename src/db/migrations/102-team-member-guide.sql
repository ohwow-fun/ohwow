-- 102-team-member-guide.sql
-- Link a team member to their dedicated "chief of staff" guide agent.
-- Also adds timezone, cloud_invite_token (for pending invites), and
-- onboarding_status so the orchestrator can track whether person
-- ingestion has been kicked off / completed.

ALTER TABLE agent_workforce_team_members ADD COLUMN assigned_guide_agent_id TEXT DEFAULT NULL;
ALTER TABLE agent_workforce_team_members ADD COLUMN timezone TEXT DEFAULT NULL;
ALTER TABLE agent_workforce_team_members ADD COLUMN cloud_invite_token TEXT DEFAULT NULL;
ALTER TABLE agent_workforce_team_members ADD COLUMN cloud_invite_status TEXT DEFAULT NULL;
ALTER TABLE agent_workforce_team_members ADD COLUMN onboarding_status TEXT DEFAULT 'not_started';

CREATE INDEX IF NOT EXISTS idx_team_members_guide
  ON agent_workforce_team_members(assigned_guide_agent_id);
