ALTER TABLE agent_workforce_team_members ADD COLUMN notification_preferences TEXT DEFAULT NULL;
ALTER TABLE agent_workforce_team_members ADD COLUMN briefing_preferences TEXT DEFAULT NULL;
ALTER TABLE agent_workforce_team_members ADD COLUMN visible_agent_ids TEXT DEFAULT NULL;
ALTER TABLE agent_workforce_team_members ADD COLUMN group_label TEXT DEFAULT NULL;
ALTER TABLE agent_workforce_team_members ADD COLUMN avatar_url TEXT DEFAULT NULL;
ALTER TABLE agent_workforce_team_members ADD COLUMN phone TEXT DEFAULT NULL;

ALTER TABLE agent_workforce_briefings ADD COLUMN team_member_id TEXT DEFAULT NULL;
