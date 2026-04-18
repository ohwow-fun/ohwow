import type { ModeLens } from './types.js';

/**
 * Plumbing lens — distilled from
 * `.claude/skills/be-ohwow/briefs/plumbing.md`. Tables / verbs / families
 * mirror the spec's "Mode lenses" table verbatim.
 */
export const plumbingLens: ModeLens = {
  mode: 'plumbing',
  description:
    'Fix one bug class across all callers: localFetch-vs-cloudFetch, missing daemon endpoint, envelope mismatch, hardcoded workspace_id/port.',
  plan_brief_preamble: [
    'MODE: plumbing. Reproduce the failure end-to-end and capture the raw error (Postgres code / HTTP status / thrown message).',
    'Map the failure to one of the known classes (localFetch/cloudFetch, missing daemon route, cloud-local drift, envelope mismatch, hardcoded workspace_id/port). If no match, escalate; do not invent a new class mid-plan.',
    'Enumerate EVERY caller in the class via grep. Impl round must touch each one. If wider than enumerated, stop with partial.',
    'Dual-update SQL when schema changes: sql_current/ (final CREATE) AND sql/migrations/ (incremental).',
    'QA re-runs the original repro, walks every caller, and writes at least one regression-class test (route integration, fetch-adapter contract).',
  ].join('\n'),
  tables: [
    'agent_workforce_tasks',
    'agent_workforce_task_state',
    'state_changelog',
    'local_triggers',
    'outbound_queue',
    'experiment_validations',
  ],
  mcp_verbs: [
    'ohwow_list_failing_triggers',
    'ohwow_daemon_status',
    'ohwow_workspace_status',
  ],
  experiment_families: [
    'migration-drift-sentinel',
    'migration-schema-probe',
    'agent-state-hygiene-sentinel',
    'loop-cadence-probe',
    'agent-lock-contention',
    'intervention-audit',
    'device-audit',
  ],
};
