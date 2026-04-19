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
];

export function getSpec(table: string): SyncTableSpec | undefined {
  return SYNC_REGISTRY.find((s) => s.table === table);
}

export function listTables(): string[] {
  return SYNC_REGISTRY.map((s) => s.table);
}
