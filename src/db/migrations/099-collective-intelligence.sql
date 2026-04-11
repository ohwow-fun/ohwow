-- Collective Intelligence: add collective_briefing to person models
-- Phase 6 of Center of Operations (capstone)

ALTER TABLE agent_workforce_person_models
  ADD COLUMN collective_briefing TEXT DEFAULT '{}';
