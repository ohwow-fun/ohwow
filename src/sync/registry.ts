/**
 * Runtime → cloud bulk sync registry.
 *
 * Adding a table here is the only edit required for it to be sync-able
 * via `scripts/sync-runtime-to-cloud.ts`. Trios 3-4 of the sync arc add
 * autonomy + x-intel entries here.
 *
 * Distinct from src/control-plane/sync-resources.ts (which dispatches
 * per-row events on tool execution). This registry powers the manual
 * one-shot CLI path used for backfill + verification.
 *
 * Limitations (v1):
 *   - inserts/upserts only; deletes are NOT propagated.
 *   - cloud-side mutations are silently overwritten (runtime wins).
 */
export interface SyncTableSpec {
  /** sqlite source table */
  table: string;
  /** cloud destination table; defaults to `table` if omitted */
  cloudTable?: string;
  /** primary key column (always the upsert join key) */
  primaryKey: string;
  /** ordered list of columns to read from sqlite + write to cloud */
  columns: string[];
  /** true → script honors workspace_sync_config opt-out; false → global table */
  isWorkspaceScoped: boolean;
  /** human note re typing/promotions, surfaced in --dry-run */
  notes?: string;
}

export const SYNC_REGISTRY: SyncTableSpec[] = [
  {
    table: 'director_arcs',
    primaryKey: 'id',
    columns: [
      'id', 'workspace_id', 'opened_at', 'closed_at',
      'mode_of_invocation', 'thesis', 'status',
      'budget_max_phases', 'budget_max_minutes', 'budget_max_inbox_qs',
      'kill_on_pulse_regression', 'pulse_at_entry', 'pulse_at_close',
      'exit_reason',
    ],
    isWorkspaceScoped: true,
    notes:
      'id TEXT (non-uuid runtime ids) → cloud text; workspace_id → uuid; ' +
      '*_at TEXT → timestamptz; pulse_at_entry/pulse_at_close TEXT (JSON) ' +
      '→ cloud text (no `_json` suffix → script coerceValue passes through ' +
      'as-is, cloud column typed text not jsonb).',
  },
  {
    table: 'director_phase_reports',
    primaryKey: 'id',
    columns: [
      'id', 'arc_id', 'workspace_id', 'phase_id', 'mode', 'goal', 'status',
      'trios_run',
      'runtime_sha_start', 'runtime_sha_end',
      'cloud_sha_start', 'cloud_sha_end',
      'delta_pulse_json', 'delta_ledger', 'inbox_added',
      'remaining_scope', 'next_phase_recommendation',
      'cost_trios', 'cost_minutes', 'cost_llm_cents',
      'raw_report', 'started_at', 'ended_at',
    ],
    isWorkspaceScoped: true,
    notes:
      'id/arc_id/phase_id TEXT → cloud text; workspace_id → uuid; ' +
      'delta_pulse_json TEXT (JSON, `_json` suffix) → cloud jsonb (auto-parsed); ' +
      'delta_ledger/inbox_added TEXT (JSON, no `_json` suffix) → cloud text; ' +
      '*_at TEXT → timestamptz. FK to director_arcs — sync director_arcs first.',
  },
  {
    table: 'founder_inbox',
    primaryKey: 'id',
    columns: [
      'id', 'workspace_id', 'arc_id', 'phase_id', 'mode',
      'blocker', 'context', 'options_json', 'recommended',
      'screenshot_path', 'asked_at', 'answered_at', 'answer', 'status',
    ],
    isWorkspaceScoped: true,
    notes: 'options_json TEXT(JSON) → jsonb cloud-side; *_at TEXT → timestamptz',
  },
  {
    table: 'phase_rounds',
    primaryKey: 'id',
    columns: [
      'id', 'trio_id', 'kind', 'status', 'summary',
      'findings_written', 'commits', 'evaluation_json', 'raw_return',
      'started_at', 'ended_at',
    ],
    isWorkspaceScoped: false,
    notes:
      'No workspace_id column — sync runs WITHOUT --workspace; opt-out via ' +
      'parent phase_trios. id/trio_id TEXT → cloud text (FK to phase_trios — ' +
      'sync phase_trios first); evaluation_json TEXT (JSON, `_json` suffix) ' +
      '→ cloud jsonb (auto-parsed); findings_written/commits TEXT (JSON, no ' +
      '`_json` suffix) → cloud text; *_at TEXT → timestamptz.',
  },
  {
    table: 'phase_trios',
    primaryKey: 'id',
    columns: [
      'id', 'phase_id', 'workspace_id', 'mode', 'outcome',
      'started_at', 'ended_at',
    ],
    isWorkspaceScoped: true,
    notes:
      'id/phase_id TEXT → cloud text; workspace_id → uuid; ' +
      '*_at TEXT → timestamptz. CHECK constraints on mode + outcome ' +
      'preserved verbatim cloud-side.',
  },
  {
    table: 'posted_log',
    primaryKey: 'id',
    columns: [
      'id', 'workspace_id', 'platform', 'text_hash', 'text_preview',
      'text_length', 'posted_at', 'approval_id', 'task_id', 'source',
    ],
    isWorkspaceScoped: true,
    notes:
      'id TEXT (32-char hex, not uuid) → cloud text; workspace_id → uuid; ' +
      'text_length INTEGER → integer; posted_at TEXT → timestamptz. ' +
      'UNIQUE (workspace_id, platform, text_hash) preserved cloud-side ' +
      'so dedup works in both directions.',
  },
  {
    table: 'x_dm_messages',
    primaryKey: 'id',
    columns: [
      'id', 'workspace_id', 'conversation_pair', 'message_id', 'direction',
      'text', 'is_media', 'observed_at',
    ],
    isWorkspaceScoped: true,
    notes:
      'id TEXT (32-char hex) → cloud text; workspace_id → uuid; ' +
      'is_media INTEGER → integer; observed_at TEXT → timestamptz. ' +
      'CHECK on direction (outbound|inbound|unknown) and UNIQUE ' +
      '(workspace_id, message_id) preserved cloud-side.',
  },
  {
    table: 'x_dm_observations',
    primaryKey: 'id',
    columns: [
      'id', 'workspace_id', 'conversation_pair', 'primary_name',
      'preview_text', 'preview_hash', 'has_unread', 'observed_at',
    ],
    isWorkspaceScoped: true,
    notes:
      'id TEXT (32-char hex) → cloud text; workspace_id → uuid; ' +
      'has_unread INTEGER → integer; observed_at TEXT → timestamptz. ' +
      'UNIQUE (workspace_id, conversation_pair, preview_hash) preserved.',
  },
  {
    table: 'x_dm_threads',
    primaryKey: 'id',
    columns: [
      'id', 'workspace_id', 'conversation_pair', 'primary_name',
      'last_preview', 'last_preview_hash', 'has_unread', 'observation_count',
      'first_seen_at', 'last_seen_at', 'raw_meta',
      'last_message_id', 'last_message_text', 'last_message_direction',
      'counterparty_user_id', 'contact_id',
    ],
    isWorkspaceScoped: true,
    notes:
      'id TEXT (32-char hex) → cloud text; workspace_id → uuid; ' +
      'has_unread/observation_count INTEGER → integer; ' +
      'first_seen_at/last_seen_at TEXT → timestamptz. raw_meta TEXT ' +
      '(JSON, no `_json` suffix) → cloud text (script coerceValue auto- ' +
      'parses by suffix only — keeps upserts working). UNIQUE ' +
      '(workspace_id, conversation_pair) preserved.',
  },
  {
    table: 'x_post_drafts',
    primaryKey: 'id',
    columns: [
      'id', 'workspace_id', 'body', 'source_finding_id', 'status',
      'created_at', 'approved_at', 'rejected_at',
    ],
    isWorkspaceScoped: true,
    notes:
      'id TEXT (32-char hex) → cloud text; workspace_id → uuid; ' +
      '*_at TEXT → timestamptz. CHECK on status (pending|approved|rejected) ' +
      'and UNIQUE (workspace_id, source_finding_id) preserved cloud-side.',
  },
  {
    table: 'x_reply_drafts',
    primaryKey: 'id',
    columns: [
      'id', 'workspace_id', 'platform', 'reply_to_url', 'reply_to_author',
      'reply_to_text', 'reply_to_likes', 'reply_to_replies', 'mode', 'body',
      'alternates_json', 'verdict_json', 'score', 'status',
      'created_at', 'approved_at', 'rejected_at', 'applied_at',
    ],
    isWorkspaceScoped: true,
    notes:
      'id TEXT (32-char hex) → cloud text; workspace_id → uuid; ' +
      'alternates_json/verdict_json TEXT (JSON, `_json` suffix) → cloud ' +
      'jsonb (auto-parsed); score REAL → double precision; ' +
      '*_at TEXT → timestamptz. CHECK on platform (x|threads), mode ' +
      '(direct|viral), status (pending|approved|rejected|applied|auto_applied) ' +
      'and UNIQUE (workspace_id, reply_to_url) preserved cloud-side.',
  },
];

export function getSpec(table: string): SyncTableSpec | undefined {
  return SYNC_REGISTRY.find((s) => s.table === table);
}

export function listTables(): string[] {
  return SYNC_REGISTRY.map((s) => s.table);
}
