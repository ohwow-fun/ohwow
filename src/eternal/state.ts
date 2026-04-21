/**
 * Eternal Systems — SQLite state helpers.
 *
 * Reads/writes the single-row `eternal_state` table (migration 148).
 * Follows the same DatabaseAdapter chaining pattern used throughout the
 * autonomy stack (director-persistence.ts, persistence.ts).
 */
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { EternalMode, EternalState } from './types.js';

// Row shape as stored in SQLite.
interface EternalStateRow {
  id: number;
  mode: string;
  last_activity_at: string | null;
  mode_changed_at: string | null;
  mode_changed_reason: string | null;
}

const SINGLETON_ID = 1;

/**
 * Read the current eternal state.
 * Returns conservative defaults when the row is missing so callers never
 * need to handle null — the table is seeded in migration 148 but defensive
 * reads are safer than assuming migration always ran.
 */
export async function getEternalState(db: DatabaseAdapter): Promise<EternalState> {
  const { data } = await db
    .from<EternalStateRow>('eternal_state')
    .select('id,mode,last_activity_at,mode_changed_at,mode_changed_reason')
    .eq('id', SINGLETON_ID)
    .maybeSingle();

  if (!data) {
    return {
      mode: 'normal',
      lastActivityAt: null,
      modeChangedAt: null,
      modeChangedReason: null,
    };
  }

  return {
    mode: data.mode as EternalMode,
    lastActivityAt: data.last_activity_at,
    modeChangedAt: data.mode_changed_at,
    modeChangedReason: data.mode_changed_reason,
  };
}

/**
 * Transition the eternal mode.
 * Records the ISO timestamp and human-readable reason for the change.
 */
export async function setEternalMode(
  db: DatabaseAdapter,
  mode: EternalMode,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .from<EternalStateRow>('eternal_state')
    .update({
      mode,
      mode_changed_at: now,
      mode_changed_reason: reason,
    })
    .eq('id', SINGLETON_ID);
}

/**
 * Record that the operator was active right now.
 * Resets `last_activity_at` to the current ISO timestamp. Call this
 * whenever a user-initiated action (API call, TUI interaction, CLI command)
 * is observed.
 */
export async function recordActivity(db: DatabaseAdapter): Promise<void> {
  const now = new Date().toISOString();
  await db
    .from<EternalStateRow>('eternal_state')
    .update({ last_activity_at: now })
    .eq('id', SINGLETON_ID);
}
