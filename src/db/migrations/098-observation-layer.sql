-- Observation Layer: add work_pattern_map to person models
-- Phase 5 of Center of Operations (integration-only approach)

ALTER TABLE agent_workforce_person_models
  ADD COLUMN work_pattern_map TEXT DEFAULT '{}';
