/**
 * Integration test: reproduce the M0.21 timestamp-format-drift bug
 * against a scratch SQLite database and confirm the triangulation
 * harness's `deliverables_since_24h` check detects it.
 *
 * The check has two resolvers:
 *   - lexicographic_iso_filter — `created_at >= 'iso-with-Z'`, the
 *     same shape list_deliverables used pre-fix
 *   - datetime_normalized_filter — `datetime(created_at) >= datetime(iso)`,
 *     which canonicalizes both formats before comparing
 *
 * In a CLEAN table (everything in ISO-with-Z, like post-migration)
 * both resolvers return the same number → check passes.
 *
 * In a MIXED table (the M0.21 scenario: some rows in SQL-default
 * `2026-04-13 19:46:18`, some in `2026-04-13T19:46:18.811Z`) the
 * lexicographic comparator silently drops every SQL-default row,
 * because `' '` (0x20) < `'T'` (0x54) at position 10. The datetime()
 * normalizer sees them. The two values disagree → check fails →
 * harness reports a disagreement → parent orchestrator would
 * delegate to the investigate sub-orchestrator.
 *
 * This file does NOT spin up a real sub-orchestrator (that requires a
 * model token and an Anthropic API call). The sub-orchestrator's
 * schema enforcer is unit-tested separately in
 * src/orchestrator/__tests__/investigate-schema-enforcer.test.ts.
 * Here we only verify the trigger end-to-end: real SQLite, real
 * resolvers, real failure detection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runTriangulation, type TriangulationCheck, type TriangulationCtx } from '../triangulation.js';
import { TRIANGULATION_CHECKS } from '../checks.js';

const WORKSPACE_ID = 'ws-fixture';

interface Fixture {
  dir: string;
  dbPath: string;
  db: Database.Database;
  ctx: TriangulationCtx;
}

function setupFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-triangulation-'));
  const dbPath = join(dir, 'runtime.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE agent_workforce_deliverables (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      deliverable_type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review',
      auto_created INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  // Build a TriangulationCtx that runs sqlite via better-sqlite3
  // against the fixture DB. The toolCtx + readJsonFile fields are
  // unused by the deliverables_since_24h check so we can stub them.
  const ctx: TriangulationCtx = {
    toolCtx: {} as TriangulationCtx['toolCtx'],
    workspaceId: WORKSPACE_ID,
    sqlite: async (query) => {
      try {
        const stmt = db.prepare(query);
        return stmt.all() as unknown[];
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    readJsonFile: async () => ({}),
  };

  return { dir, dbPath, db, ctx };
}

function teardownFixture(fixture: Fixture) {
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

// All fixture rows live on the SAME date as the cutoff so the
// lexicographic comparator hits position 10 — that's where the bug
// manifests: ' ' (0x20) < 'T' (0x54), so the SQL-default row
// `2026-04-13 06:00:00` sorts BEFORE the cutoff `2026-04-13T05:00:00.000Z`
// even though it's chronologically later. The relative `Date.now()`
// version of the helpers slipped past this because it produced rows
// dated TODAY against a cutoff dated YESTERDAY, and the date prefix
// alone made them incomparable at position 9.
const FIXED_NOW = new Date('2026-04-14T05:00:00.000Z');

/** Build an ISO-with-Z timestamp for hour H on the day BEFORE FIXED_NOW. */
function isoYesterday(hour: number): string {
  return `2026-04-13T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

/** Build a SQL-default `YYYY-MM-DD HH:MM:SS` timestamp for hour H on the day BEFORE FIXED_NOW. */
function sqlDefaultYesterday(hour: number): string {
  return `2026-04-13 ${String(hour).padStart(2, '0')}:00:00`;
}

function insertRow(db: Database.Database, id: string, createdAt: string) {
  db.prepare(
    `INSERT INTO agent_workforce_deliverables (id, workspace_id, deliverable_type, title, content, created_at) VALUES (?, ?, 'document', ?, '{}', ?)`,
  ).run(id, WORKSPACE_ID, `row-${id}`, createdAt);
}

describe('triangulation deliverables_since_24h check', () => {
  let fixture: Fixture;
  let check: TriangulationCheck;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    fixture = setupFixture();
    const found = TRIANGULATION_CHECKS.find((c) => c.id === 'deliverables_since_24h');
    if (!found) throw new Error('expected deliverables_since_24h check to exist in TRIANGULATION_CHECKS');
    check = found;
  });

  afterEach(() => {
    teardownFixture(fixture);
    vi.useRealTimers();
  });

  it('passes when every row is in ISO-with-Z format', async () => {
    // 7 ISO rows on the same date as the cutoff, hours 6..12
    for (let h = 6; h < 13; h++) {
      insertRow(fixture.db, `iso-${h}`, isoYesterday(h));
    }

    const result = await runTriangulation([check], fixture.ctx);
    expect(result.passedChecks).toBe(1);
    expect(result.failedChecks).toEqual([]);

    const values = result.results[0].resolverValues.map((r) => r.value);
    expect(values[0]).toBe(7);
    expect(values[1]).toBe(7);
  });

  it('fails (the M0.21 bug) when the table has mixed formats', async () => {
    // 5 ISO-with-Z rows + 10 SQL-default rows, all on the same date
    // as the cutoff. The lexicographic filter sees only the 5 ISO
    // rows because at position 10 ' ' (space, 0x20) < 'T' (0x54),
    // so every SQL-default row sorts BEFORE the ISO cutoff string.
    // The datetime() filter normalizes both shapes and sees all 15.
    for (let h = 6; h < 11; h++) {
      insertRow(fixture.db, `iso-${h}`, isoYesterday(h));
    }
    for (let h = 6; h < 16; h++) {
      insertRow(fixture.db, `sql-${h}`, sqlDefaultYesterday(h));
    }

    const result = await runTriangulation([check], fixture.ctx);

    expect(result.passedChecks).toBe(0);
    expect(result.failedChecks).toHaveLength(1);

    const failure = result.failedChecks[0];
    expect(failure.checkId).toBe('deliverables_since_24h');
    expect(failure.disagreement).toBeDefined();

    const lexValue = failure.resolverValues.find((r) => r.name === 'lexicographic_iso_filter')?.value;
    const normValue = failure.resolverValues.find((r) => r.name === 'datetime_normalized_filter')?.value;
    expect(lexValue).toBe(5);   // sees only the ISO-with-Z rows
    expect(normValue).toBe(15); // sees both formats
  });

  it('fails for a single mixed row, even on a tiny table', async () => {
    // Edge case: the harness catches the drift even when the gap is
    // one row. Guards against a future "round up to nearest" or
    // "approximately equal" comparator hiding small regressions.
    insertRow(fixture.db, 'iso-1', isoYesterday(7));
    insertRow(fixture.db, 'sql-1', sqlDefaultYesterday(7));

    const result = await runTriangulation([check], fixture.ctx);
    expect(result.passedChecks).toBe(0);
    const failure = result.failedChecks[0];
    expect(failure.resolverValues.find((r) => r.name === 'lexicographic_iso_filter')?.value).toBe(1);
    expect(failure.resolverValues.find((r) => r.name === 'datetime_normalized_filter')?.value).toBe(2);
  });

  it('passes again after backfilling the SQL-default rows to ISO format', async () => {
    // Recreate the M0.21 bug then apply the migration-112 backfill
    // and re-check. Both resolvers should now agree.
    for (let h = 6; h < 11; h++) {
      insertRow(fixture.db, `iso-${h}`, isoYesterday(h));
    }
    for (let h = 6; h < 16; h++) {
      insertRow(fixture.db, `sql-${h}`, sqlDefaultYesterday(h));
    }

    fixture.db.exec(
      "UPDATE agent_workforce_deliverables SET created_at = strftime('%Y-%m-%dT%H:%M:%f', created_at) || 'Z' WHERE created_at NOT LIKE '%T%Z'",
    );

    const result = await runTriangulation([check], fixture.ctx);
    expect(result.passedChecks).toBe(1);

    const values = result.results[0].resolverValues.map((r) => r.value);
    expect(values[0]).toBe(15);
    expect(values[1]).toBe(15);
  });
});

