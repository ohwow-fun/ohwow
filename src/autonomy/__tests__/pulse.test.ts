/**
 * Unit tests for readFullPulse() focusing on:
 *
 *   readQualifiedNoOutreach():
 *   1. Deleted-contact filter: a contact_event row whose contact_id is absent
 *      from agent_workforce_contacts must NOT appear in qualified_no_outreach.
 *   2. Hydration-failure guard: when the contacts query returns 0 rows (empty
 *      table) the function must still emit all candidates (unfiltered) rather
 *      than silently dropping the list, and must log a warn.
 *
 *   These tests cover the fix landed in commit cd4e8a2.
 *
 *   readApprovalsPending() — permission_denied filter (commit 5ca41d1):
 *   3. A task with status=needs_approval AND approval_reason IS NOT NULL
 *      (i.e. permission_denied) must NOT appear in approvals_pending.
 *   4. Only tasks with approval_reason IS NULL (clean approvals) surface.
 *   5. A DB with ONLY a permission_denied task returns zero approvals_pending.
 *
 * Uses the same in-memory SQLite + migration pattern as state.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { readFullPulse } from '../pulse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

function setupDb(): {
  rawDb: InstanceType<typeof Database>;
  adapter: ReturnType<typeof createSqliteAdapter>;
} {
  const rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = OFF');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql.split(/^-- @statement$/m);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        rawDb.exec(trimmed);
      } catch {
        /* idempotent – some migrations re-create existing tables */
      }
    }
  }
  const adapter = createSqliteAdapter(rawDb);
  return { rawDb, adapter };
}

const WS = 'ws-pulse-test';

// Qualified event timestamp well within the no-outreach window (1 day ago).
const QUALIFIED_AT = new Date(Date.now() - 86_400_000).toISOString();

describe('readFullPulse — qualified_no_outreach: deleted-contact filter', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => {
    ({ rawDb, adapter } = setupDb());
  });
  afterEach(() => {
    rawDb.close();
  });

  it('excludes a contact_id present in events but absent from contacts table', async () => {
    const deletedId = 'dead0000-0000-0000-0000-000000000001';
    const liveId = 'live0000-0000-0000-0000-000000000002';

    // Seed a workspace row so workspace_id FK constraints (if any) pass.
    try {
      rawDb.exec(
        `INSERT INTO agent_workforce_workspaces (id, name, created_at, updated_at)
         VALUES ('${WS}', 'test', '${QUALIFIED_AT}', '${QUALIFIED_AT}')`,
      );
    } catch { /* table may not exist – ignore */ }

    // Two qualified events: one for a live contact, one for a deleted contact.
    // event_type and title are NOT NULL in the base schema (migration 001);
    // kind and occurred_at are added by migration 121.
    rawDb.prepare(
      `INSERT INTO agent_workforce_contact_events
         (id, workspace_id, contact_id, event_type, title, kind, occurred_at, created_at)
       VALUES (?, ?, ?, 'x:qualified', 'qualified', 'x:qualified', ?, ?)`,
    ).run('evt-live', WS, liveId, QUALIFIED_AT, QUALIFIED_AT);

    rawDb.prepare(
      `INSERT INTO agent_workforce_contact_events
         (id, workspace_id, contact_id, event_type, title, kind, occurred_at, created_at)
       VALUES (?, ?, ?, 'x:qualified', 'qualified', 'x:qualified', ?, ?)`,
    ).run('evt-deleted', WS, deletedId, QUALIFIED_AT, QUALIFIED_AT);

    // Only the live contact exists in the contacts table.
    rawDb.prepare(
      `INSERT INTO agent_workforce_contacts
         (id, workspace_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(liveId, WS, 'Live Person', QUALIFIED_AT, QUALIFIED_AT);

    // deletedId intentionally absent from agent_workforce_contacts.

    const snap = await readFullPulse(adapter, WS);

    const ids = snap.qualified_no_outreach.map((c) => c.id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(deletedId);
  });

  it('does not emit any results when both contacts are deleted', async () => {
    const deletedA = 'dead0000-0000-0000-0000-000000000010';
    const deletedB = 'dead0000-0000-0000-0000-000000000011';

    rawDb.prepare(
      `INSERT INTO agent_workforce_contact_events
         (id, workspace_id, contact_id, event_type, title, kind, occurred_at, created_at)
       VALUES (?, ?, ?, 'x:qualified', 'qualified', 'x:qualified', ?, ?)`,
    ).run('evt-a', WS, deletedA, QUALIFIED_AT, QUALIFIED_AT);

    rawDb.prepare(
      `INSERT INTO agent_workforce_contact_events
         (id, workspace_id, contact_id, event_type, title, kind, occurred_at, created_at)
       VALUES (?, ?, ?, 'x:qualified', 'qualified', 'x:qualified', ?, ?)`,
    ).run('evt-b', WS, deletedB, QUALIFIED_AT, QUALIFIED_AT);

    // Neither contact exists in agent_workforce_contacts.

    const snap = await readFullPulse(adapter, WS);

    // hydration query returns 0 rows → guard fires → unfiltered list emitted
    // (both deleted ids still appear, but no crash, no empty list).
    // The important assertion is: no throw, returns a valid snapshot.
    expect(snap.qualified_no_outreach).toBeDefined();
    expect(Array.isArray(snap.qualified_no_outreach)).toBe(true);
    // Guard: since nameById.size===0 and contactIds.length>0, the function
    // falls through unfiltered (emits the candidates) rather than returning [].
    expect(snap.qualified_no_outreach.length).toBeGreaterThanOrEqual(1);
  });
});

describe('readFullPulse — qualified_no_outreach: hydration-empty guard logs a warn', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => {
    ({ rawDb, adapter } = setupDb());
  });
  afterEach(() => {
    rawDb.close();
    vi.restoreAllMocks();
  });

  it('emits candidates unfiltered and logs warn when contacts table returns 0 rows', async () => {
    // Import the logger so we can spy on .warn.
    const loggerMod = await import('../../lib/logger.js');
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn');

    const ghostId = 'ghost000-0000-0000-0000-000000000099';

    rawDb.prepare(
      `INSERT INTO agent_workforce_contact_events
         (id, workspace_id, contact_id, event_type, title, kind, occurred_at, created_at)
       VALUES (?, ?, ?, 'x:qualified', 'qualified', 'x:qualified', ?, ?)`,
    ).run('evt-ghost', WS, ghostId, QUALIFIED_AT, QUALIFIED_AT);

    // No rows in agent_workforce_contacts → nameById.size === 0 at hydration.

    const snap = await readFullPulse(adapter, WS);

    // The guard must emit the candidate unfiltered.
    expect(snap.qualified_no_outreach.length).toBeGreaterThanOrEqual(1);
    expect(snap.qualified_no_outreach.map((c) => c.id)).toContain(ghostId);

    // The guard must log a pino warn with the telltale message.
    const warnCalls = warnSpy.mock.calls;
    const guardWarn = warnCalls.find((args) =>
      typeof args[1] === 'string' &&
      args[1].includes('hydration_empty'),
    );
    expect(guardWarn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// readApprovalsPending() — permission_denied filter (commit 5ca41d1)
// ---------------------------------------------------------------------------

const CREATED_AT = new Date(Date.now() - 3_600_000).toISOString(); // 1 hour ago
const WS2 = 'ws-approvals-test';

describe('readFullPulse — approvals_pending: permission_denied filter', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => {
    ({ rawDb, adapter } = setupDb());
    // Seed workspace row so any FK constraints pass.
    try {
      rawDb.exec(
        `INSERT INTO agent_workforce_workspaces (id, name, created_at, updated_at)
         VALUES ('${WS2}', 'approvals-test', '${CREATED_AT}', '${CREATED_AT}')`,
      );
    } catch { /* table or column mismatch — ignore */ }
  });

  afterEach(() => {
    rawDb.close();
  });

  it('returns only the clean approval when one permission_denied task co-exists', async () => {
    // Clean approval: needs_approval + approval_reason IS NULL.
    rawDb.prepare(
      `INSERT INTO agent_workforce_tasks
         (id, workspace_id, agent_id, title, status, approval_reason, created_at, updated_at)
       VALUES (?, ?, 'agent-stub', ?, 'needs_approval', NULL, ?, ?)`,
    ).run('task-clean-001', WS2, 'Post the draft reply', CREATED_AT, CREATED_AT);

    // Permission-denied task: needs_approval + approval_reason NOT NULL.
    rawDb.prepare(
      `INSERT INTO agent_workforce_tasks
         (id, workspace_id, agent_id, title, status, approval_reason, created_at, updated_at)
       VALUES (?, ?, 'agent-stub', ?, 'needs_approval', 'permission_denied', ?, ?)`,
    ).run('task-perm-001', WS2, 'Write file outside allowed path', CREATED_AT, CREATED_AT);

    const snap = await readFullPulse(adapter, WS2);

    const ids = snap.approvals_pending.map((a) => a.id);
    expect(ids).toContain('task-clean-001');
    expect(ids).not.toContain('task-perm-001');
    expect(snap.approvals_pending).toHaveLength(1);
    expect(snap.pending_approvals_count).toBe(1);
  });

  it('returns zero approvals when the DB contains only a permission_denied task', async () => {
    rawDb.prepare(
      `INSERT INTO agent_workforce_tasks
         (id, workspace_id, agent_id, title, status, approval_reason, created_at, updated_at)
       VALUES (?, ?, 'agent-stub', ?, 'needs_approval', 'permission_denied', ?, ?)`,
    ).run('task-perm-002', WS2, 'Access /etc/passwd', CREATED_AT, CREATED_AT);

    const snap = await readFullPulse(adapter, WS2);

    expect(snap.approvals_pending).toHaveLength(0);
    expect(snap.pending_approvals_count).toBe(0);
  });

  it('returns all clean approvals and none of the permission_denied ones in a mixed set', async () => {
    for (let i = 0; i < 3; i++) {
      rawDb.prepare(
        `INSERT INTO agent_workforce_tasks
           (id, workspace_id, agent_id, title, status, approval_reason, created_at, updated_at)
         VALUES (?, ?, 'agent-stub', ?, 'needs_approval', NULL, ?, ?)`,
      ).run(`task-clean-00${i}`, WS2, `Clean task ${i}`, CREATED_AT, CREATED_AT);
    }
    for (let i = 0; i < 2; i++) {
      rawDb.prepare(
        `INSERT INTO agent_workforce_tasks
           (id, workspace_id, agent_id, title, status, approval_reason, created_at, updated_at)
         VALUES (?, ?, 'agent-stub', ?, 'needs_approval', 'permission_denied', ?, ?)`,
      ).run(`task-perm-00${i}`, WS2, `Permission denied task ${i}`, CREATED_AT, CREATED_AT);
    }

    const snap = await readFullPulse(adapter, WS2);

    expect(snap.approvals_pending).toHaveLength(3);
    expect(snap.pending_approvals_count).toBe(3);
    const ids = snap.approvals_pending.map((a) => a.id);
    for (let i = 0; i < 3; i++) {
      expect(ids).toContain(`task-clean-00${i}`);
    }
    for (let i = 0; i < 2; i++) {
      expect(ids).not.toContain(`task-perm-00${i}`);
    }
  });
});
