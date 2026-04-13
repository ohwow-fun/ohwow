-- TTL + lazy cleanup for agent_workforce_task_state.
--
-- The state table had no expiration mechanism, so once an agent wrote a key
-- (incident flag, health check, scratch value, etc.) it lived forever. Stale
-- rows from old sessions polluted reasoning: agents would get_state on a key
-- that was set during a long-dead incident, see RED, and refuse the unrelated
-- task in front of them.
--
-- expires_at is NULL for persistent state (the default for keys that don't
-- match the heuristic prefixes in state.ts). For ephemeral keys (incident_*,
-- *_health_*, temp_*, scratch_*) state.ts now writes a 24h default expiry.
-- getAgentState filters expired rows on read and lazy-deletes them so the
-- next reader doesn't trip the same poisoning.
--
-- The DELETE at the bottom is a one-shot purge of the two known-poisoning
-- keys observed in production today. They are not written by any current
-- code path (verified) so deleting them is a clean fix; they cannot grow
-- back through normal use.

ALTER TABLE agent_workforce_task_state
  ADD COLUMN expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_task_state_expires
  ON agent_workforce_task_state(expires_at)
  WHERE expires_at IS NOT NULL;

DELETE FROM agent_workforce_task_state
  WHERE key IN ('last_health_check', 'incident_scrapling_down');
