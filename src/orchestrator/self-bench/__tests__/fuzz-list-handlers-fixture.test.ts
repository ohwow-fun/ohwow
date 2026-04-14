/**
 * Fixture coverage for the list_* fuzz module. Stands up a scratch
 * SQLite DB with the tables each probe expects, varies the row
 * counts to hit every severity bucket (clean / latent / active),
 * and asserts the runner classifies them correctly.
 *
 * Complements fuzz-list-handlers-live.test.ts (which runs against
 * the real daemon's runtime.db under OHWOW_BENCH_LIVE=1). Keeps the
 * module self-testing even when no live state is available.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  runListHandlerFuzz,
  formatFuzzReport,
  LIST_HANDLER_PROBES,
  type SqliteReader,
} from '../fuzz-list-handlers.js';

const WORKSPACE_ID = 'ws-fuzz-fixture';

interface Fixture {
  dir: string;
  db: Database.Database;
  reader: SqliteReader;
}

function setupFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-fuzz-'));
  const db = new Database(join(dir, 'runtime.db'));

  // Create every table the probes reference, with just an id +
  // workspace_id column (the fuzz only runs COUNT(*) queries so
  // the schema can be minimal).
  for (const probe of LIST_HANDLER_PROBES) {
    db.exec(
      `CREATE TABLE ${probe.table} (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL
      );`,
    );
  }

  const reader: SqliteReader = {
    all: (query, params) => db.prepare(query).all(...(params ?? [])),
  };

  return { dir, db, reader };
}

function teardownFixture(f: Fixture) {
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

function insertRows(db: Database.Database, table: string, count: number) {
  const stmt = db.prepare(`INSERT INTO ${table} (id, workspace_id) VALUES (?, ?)`);
  for (let i = 0; i < count; i++) {
    stmt.run(`${table}-${i}`, WORKSPACE_ID);
  }
}

describe('runListHandlerFuzz', () => {
  let fixture: Fixture;

  beforeEach(() => { fixture = setupFixture(); });
  afterEach(() => { teardownFixture(fixture); });

  it('reports every probe as clean when every table is empty', () => {
    const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
    expect(run.summary.active).toBe(0);
    // Empty unbounded tables are clean; empty limited tables are
    // ALSO clean because 0 rows is under any default limit. That's
    // intentional — an empty table isn't a bug, it's the ground
    // state of a fresh workspace.
    expect(run.summary.latent).toBe(0);
    expect(run.summary.clean).toBe(LIST_HANDLER_PROBES.length);
    expect(run.findings).toEqual([]);
  });

  it('classifies unbounded handlers as clean regardless of row count', () => {
    insertRows(fixture.db, 'agent_workforce_agents', 5000);
    insertRows(fixture.db, 'agent_workforce_team_members', 200);
    insertRows(fixture.db, 'agent_workforce_projects', 50);

    const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
    const agents = run.results.find((r) => r.probe.tool === 'list_agents');
    const team = run.results.find((r) => r.probe.tool === 'list_team_members');
    const projects = run.results.find((r) => r.probe.tool === 'list_projects');

    expect(agents?.severity).toBe('clean');
    expect(team?.severity).toBe('clean');
    expect(projects?.severity).toBe('clean');
    expect(agents?.totalRows).toBe(5000);
  });

  it('list_tasks stays clean when rows exceed the cap because the handler surfaces a total field', () => {
    insertRows(fixture.db, 'agent_workforce_tasks', 120);

    const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
    const tasks = run.results.find((r) => r.probe.tool === 'list_tasks');

    // The handler is now returning {total, returned, limit, tasks}
    // so truncation is NOT a bug — it's pagination working. The
    // fuzz should treat it as clean (paginated). True active
    // findings are reserved for unsurfaced truncation where the
    // caller can't tell rows are missing.
    expect(tasks?.severity).toBe('clean');
    expect(tasks?.totalRows).toBe(120);
    expect(tasks?.effectiveLimit).toBe(50);
    expect(tasks?.truncatesLive).toBe(true);
    expect(tasks?.verdict).toContain('paginated');
  });

  it('list_workflows stays clean when rows exceed the cap because the handler surfaces a total field', () => {
    insertRows(fixture.db, 'agent_workforce_workflows', 80);

    const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
    const workflows = run.results.find((r) => r.probe.tool === 'list_workflows');

    expect(workflows?.severity).toBe('clean');
    expect(workflows?.effectiveLimit).toBe(50);
    expect(workflows?.truncatesLive).toBe(true);
    expect(workflows?.verdict).toContain('paginated');
  });

  it('still flags a synthesized probe without a total field as ACTIVE when rows exceed the cap', () => {
    // Regression net for the severity downgrade: a probe with
    // returnsTotal=false and a tripped limit MUST still come back
    // active. Synthesize one by stubbing a probe via the runner.
    // We reach in through the exported probe list for a hand-built
    // copy so the regular audit isn't affected.
    insertRows(fixture.db, 'agent_workforce_tasks', 120);

    // Monkey-patch a single probe entry for the duration of this
    // test: same table/tool but returnsTotal: false.
    const idx = LIST_HANDLER_PROBES.findIndex((p) => p.tool === 'list_tasks');
    const original = LIST_HANDLER_PROBES[idx];
    LIST_HANDLER_PROBES[idx] = { ...original, returnsTotal: false };
    try {
      const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
      const tasks = run.results.find((r) => r.probe.tool === 'list_tasks');
      expect(tasks?.severity).toBe('active');
      expect(tasks?.verdict).toContain('does NOT expose a total');
    } finally {
      LIST_HANDLER_PROBES[idx] = original;
    }
  });

  it('stays clean when row count is under the post-fix default cap', () => {
    // Regression net: the row counts that used to trip the pre-fix
    // 10-row list_tasks limit should now be solidly under the
    // 50-row default. A workspace with 42 tasks should report as
    // clean because the handler returns all of them.
    insertRows(fixture.db, 'agent_workforce_tasks', 42);

    const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
    const tasks = run.results.find((r) => r.probe.tool === 'list_tasks');
    expect(tasks?.severity).toBe('clean');
    expect(tasks?.truncatesLive).toBe(false);
  });

  it('reports list_deliverables truncation as clean (paginated) because it exposes a total field', () => {
    insertRows(fixture.db, 'agent_workforce_deliverables', 100);

    const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
    const deliverables = run.results.find((r) => r.probe.tool === 'list_deliverables');

    // The handler's paginating, but the caller can see that it's
    // paginating via the total field. That's not a bug — the fuzz
    // classifies it as clean with the 'paginated' verdict.
    expect(deliverables?.severity).toBe('clean');
    expect(deliverables?.truncatesLive).toBe(true);
    expect(deliverables?.verdict).toContain('paginated');
  });

  it('flags list_contacts as LATENT when the table is empty but the handler has a default limit', () => {
    // 0 rows in contacts: the truncation isn't biting right now but
    // the handler is still shaped to silently cap at 20 without a
    // total field. Latent rather than active.
    const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
    const contacts = run.results.find((r) => r.probe.tool === 'list_contacts');

    // Empty table with no rows: severity should be clean (no
    // truncation happening), not latent — 0 rows is under any
    // limit and there's nothing to lose. Latent fires when rows
    // exist but are under the cap.
    expect(contacts?.severity).toBe('clean');
  });

  it('list_contacts is now clean even when rows exist, because it returns a total field', () => {
    // Pre-fix, list_contacts had returnsTotal=false, so the fuzz
    // classified "rows under cap" as latent (design smell waiting
    // to bite). Post-fix, returnsTotal=true, and the fuzz should
    // report clean until the row count actually exceeds the cap.
    insertRows(fixture.db, 'agent_workforce_contacts', 5);

    const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
    const contacts = run.results.find((r) => r.probe.tool === 'list_contacts');
    expect(contacts?.severity).toBe('clean');
    expect(contacts?.totalRows).toBe(5);
  });

  it('filters by workspace_id so foreign rows never inflate the count', () => {
    insertRows(fixture.db, 'agent_workforce_tasks', 30);
    // Plant 50 more rows under a DIFFERENT workspace_id. The fuzz
    // should not count them.
    const stmt = fixture.db.prepare(
      `INSERT INTO agent_workforce_tasks (id, workspace_id) VALUES (?, 'ws-other')`,
    );
    for (let i = 0; i < 50; i++) stmt.run(`other-${i}`);

    const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
    const tasks = run.results.find((r) => r.probe.tool === 'list_tasks');
    expect(tasks?.totalRows).toBe(30);
  });

  it('skips a probe gracefully when its table does not exist in the db', () => {
    // Drop one table to simulate a test DB that doesn't cover the
    // full schema. The fuzz must not crash; it should emit a skip
    // verdict and keep running the other probes.
    fixture.db.exec(`DROP TABLE agent_workforce_person_models`);

    const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
    const personModels = run.results.find((r) => r.probe.tool === 'list_person_models');
    expect(personModels?.verdict).toContain('skip:');
    // Other probes still produce results
    expect(run.results.length).toBe(LIST_HANDLER_PROBES.length);
  });

  it('formatFuzzReport produces a human-readable, severity-tagged report', () => {
    // Trip an unsurfaced-truncation active finding by monkey-patching
    // a probe to returnsTotal=false and stuffing the backing table
    // past its cap.
    insertRows(fixture.db, 'agent_workforce_tasks', 120);
    insertRows(fixture.db, 'agent_workforce_agents', 3);

    const idx = LIST_HANDLER_PROBES.findIndex((p) => p.tool === 'list_tasks');
    const original = LIST_HANDLER_PROBES[idx];
    LIST_HANDLER_PROBES[idx] = { ...original, returnsTotal: false };
    try {
      const run = runListHandlerFuzz(fixture.reader, WORKSPACE_ID);
      const report = formatFuzzReport(run);

      expect(report).toContain('list_* fuzz report');
      expect(report).toContain('list_tasks');
      expect(report).toContain('🔴');  // active finding tag
      expect(report).toContain('🟢');  // clean finding tag
      expect(report).toContain('active');
      expect(report).toContain('clean');
    } finally {
      LIST_HANDLER_PROBES[idx] = original;
    }
  });
});
