-- =====================================================================
-- Migration 115: Trigger watchdog columns
--
-- Experiment E2: give the daemon a way to notice that a scheduled
-- trigger has been silently miscarrying. Without this, the diary
-- trigger shipped silent failures for 2+ weeks before anyone checked
-- — the trigger fired, the task failed, and nothing aggregated the
-- outcome at the trigger level.
--
-- Columns:
--   local_triggers.last_succeeded_at      — ISO timestamp, set on every
--                                           task completion that
--                                           traces back to this trigger.
--   local_triggers.consecutive_failures   — int counter. Incremented on
--                                           every failed/needs_approval
--                                           outcome; reset to 0 on
--                                           success. Crossing the
--                                           threshold (default 3) emits
--                                           a trigger_stuck activity row
--                                           so the operator's existing
--                                           activity surface picks it up
--                                           without new UI.
--   agent_workforce_tasks.source_trigger_id — FK-ish back-link so the
--                                             task finalization hook can
--                                             find which trigger to
--                                             update without walking the
--                                             title prefix or parsing
--                                             action_result JSON.
--
-- The resumed child task spawned by ohwow_approve_permission_request
-- inherits source_trigger_id from its parent so a successful resume
-- also resets the trigger counter.
-- =====================================================================

-- @statement
ALTER TABLE local_triggers ADD COLUMN last_succeeded_at TEXT;
-- @statement
ALTER TABLE local_triggers ADD COLUMN consecutive_failures INTEGER DEFAULT 0;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN source_trigger_id TEXT;
-- @statement
CREATE INDEX IF NOT EXISTS idx_tasks_source_trigger
  ON agent_workforce_tasks(source_trigger_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_triggers_consecutive_failures
  ON local_triggers(consecutive_failures DESC) WHERE consecutive_failures > 0;
