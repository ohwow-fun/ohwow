-- =====================================================================
-- Migration 113: Filesystem permission requests
--
-- When an agent's filesystem/bash call hits FileAccessGuard the task now
-- throws PermissionDeniedError and lands in needs_approval instead of
-- returning an error string that the model hallucinates around. These
-- columns back that flow:
--
--   approval_reason       — typed discriminator on needs_approval rows.
--                           'permission_denied' is the new value the
--                           approval routing writes; existing deliverable
--                           and verifier-escalation paths can migrate to
--                           it incrementally.
--   permission_request    — JSON describing the denied call (tool name,
--                           attempted path, suggestedExact, suggestedParent,
--                           guardReason, iteration, timestamp).
--   permission_grants     — JSON array of ephemeral "approve once" paths
--                           carried on a resumed child task. Read by
--                           resolveTaskCapabilities and union'd into the
--                           FileAccessGuard so the child can write without
--                           persisting a row in agent_file_access_paths.
--   resumed_from_task_id  — backref so the UI can thread resume chains
--                           when the operator approves a denied task.
-- =====================================================================

-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN approval_reason TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN permission_request TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN permission_grants TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN resumed_from_task_id TEXT;
-- @statement
CREATE INDEX IF NOT EXISTS idx_tasks_approval_reason
  ON agent_workforce_tasks(approval_reason);
