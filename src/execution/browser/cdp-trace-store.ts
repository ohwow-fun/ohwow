/**
 * CDP Trace Store — fire-and-forget persistence for cdp:true log events.
 *
 * A module-level singleton holds the DatabaseAdapter + workspaceId after
 * `initCdpTraceDb` is called once at daemon boot. All insertions are
 * async and errors are silently swallowed so a DB hiccup never interrupts
 * a live CDP operation.
 *
 * `_resetCdpTraceDb` clears the singleton for test isolation.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

// ── module-level singleton ────────────────────────────────────────────────────

let _db: DatabaseAdapter | undefined;
let _workspaceId: string | undefined;

/** Call once at daemon boot to wire up persistence. */
export function initCdpTraceDb(db: DatabaseAdapter, workspaceId: string): void {
  _db = db;
  _workspaceId = workspaceId;
}

/** Reset singleton for test isolation. */
export function _resetCdpTraceDb(): void {
  _db = undefined;
  _workspaceId = undefined;
}

// ── types ─────────────────────────────────────────────────────────────────────

const KNOWN_COLUMNS = new Set(['action', 'profile', 'targetId', 'target_id', 'owner', 'url']);

export interface CdpTraceEventInput {
  action: string;
  profile?: string;
  targetId?: string;
  owner?: string;
  url?: string;
  [key: string]: unknown;
}

export interface CdpTraceEventRow {
  id: string;
  workspace_id: string;
  ts: string;
  action: string;
  profile: string | null;
  target_id: string | null;
  owner: string | null;
  url: string | null;
  metadata_json: string | null;
  created_at: string;
}

// ── insert ────────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget INSERT into cdp_trace_events. Silently no-ops if
 * `initCdpTraceDb` has not been called. Never throws.
 */
export function insertCdpTraceEvent(event: CdpTraceEventInput): void {
  if (!_db || !_workspaceId) return;
  const db = _db;
  const workspaceId = _workspaceId;

  void (async () => {
    try {
      // Collect extra fields into metadata_json
      const meta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(event)) {
        if (!KNOWN_COLUMNS.has(k) && k !== 'action') {
          meta[k] = v;
        }
      }

      const row: CdpTraceEventRow = {
        id: randomUUID(),
        workspace_id: workspaceId,
        ts: new Date().toISOString(),
        action: event.action,
        profile: event.profile ?? null,
        target_id: event.targetId ?? null,
        owner: event.owner ?? null,
        url: event.url ?? null,
        metadata_json: Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
        created_at: new Date().toISOString(),
      };

      await db.from<CdpTraceEventRow>('cdp_trace_events').insert(row);
    } catch (err) {
      logger.debug({ err }, '[cdp-trace-store] insert failed (non-fatal)');
    }
  })();
}
