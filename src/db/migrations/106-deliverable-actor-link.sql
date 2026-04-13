-- 106-deliverable-actor-link.sql
--
-- Add three columns to agent_workforce_deliverables so we can attribute
-- every produced artifact to who made it AND who it was made for.
--
--   produced_by_type     'agent' | 'member' | 'guide' | 'system'
--   produced_by_id       agent_id, team_member_id, or null
--   for_team_member_id   the team_member this deliverable belongs to,
--                        e.g. when the COS runs a research task on
--                        Mario's behalf the resulting cheat sheet is
--                        produced_by_type='guide', produced_by_id=COS,
--                        for_team_member_id=Mario.
--
-- The cloud activity timeline + per-person work tracking dashboards
-- query these columns to render "what did agent X produce" and
-- "what did member Y produce / receive on their behalf".

ALTER TABLE agent_workforce_deliverables ADD COLUMN produced_by_type TEXT;
-- @statement
ALTER TABLE agent_workforce_deliverables ADD COLUMN produced_by_id TEXT;
-- @statement
ALTER TABLE agent_workforce_deliverables ADD COLUMN for_team_member_id TEXT;
-- @statement
CREATE INDEX IF NOT EXISTS idx_deliverables_for_team_member
  ON agent_workforce_deliverables(for_team_member_id)
  WHERE for_team_member_id IS NOT NULL;
-- @statement
CREATE INDEX IF NOT EXISTS idx_deliverables_produced_by
  ON agent_workforce_deliverables(produced_by_type, produced_by_id);
