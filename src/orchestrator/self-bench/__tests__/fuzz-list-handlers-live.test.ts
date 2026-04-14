/**
 * Live-DB pass of the list_* handler fuzz. Opens the real
 * `~/.ohwow/workspaces/default/runtime.db` in read-only mode,
 * counts rows in every backing table, and compares against each
 * handler's documented limit shape.
 *
 * This test is designed to FAIL (visibly, with a structured report)
 * whenever the bench finds a handler that silently truncates. The
 * assertion lives at the end as a safety net; the real value is in
 * the console output showing every probe's verdict so a human (or a
 * follow-up commit) can see which handlers need a `total` field or
 * an unbounded limit.
 *
 * Skipped by default — the live DB is machine-local state, not a
 * test fixture. Set OHWOW_BENCH_LIVE=1 to run:
 *
 *   OHWOW_BENCH_LIVE=1 npx vitest run src/orchestrator/self-bench/__tests__/fuzz-list-handlers-live.test.ts
 *
 * A parallel fixture test (fuzz-list-handlers-fixture.test.ts, next
 * file over) covers the module logic with synthetic data so the fuzz
 * itself has regression coverage without needing live state.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  runListHandlerFuzz,
  formatFuzzReport,
  type SqliteReader,
} from '../fuzz-list-handlers.js';

const LIVE = process.env.OHWOW_BENCH_LIVE === '1';

describe.skipIf(!LIVE)('list_* handler fuzz against the live workspace', () => {
  it('reports every hidden-pagination finding in the default workspace', () => {
    const dbPath = join(homedir(), '.ohwow', 'workspaces', 'default', 'runtime.db');
    if (!existsSync(dbPath)) {
      throw new Error(`live runtime.db not found at ${dbPath} — is the daemon set up?`);
    }

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // Resolve the single workspace id the orchestrator uses. The
      // daemon's boot-time consolidation rewrites the seed 'local'
      // row, so read positionally instead of hardcoding.
      const row = db
        .prepare(
          `SELECT id FROM agent_workforce_workspaces ORDER BY created_at ASC LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      const workspaceId = row?.id;
      if (!workspaceId) throw new Error('no workspace row found');

      const reader: SqliteReader = {
        all: (query, params) => db.prepare(query).all(...(params ?? [])),
      };

      const run = runListHandlerFuzz(reader, workspaceId);

      // eslint-disable-next-line no-console
      console.log('\n' + formatFuzzReport(run) + '\n');

      // The assertion: zero ACTIVE findings. Latent findings are
      // design smells but don't fail the test — they're dormant
      // bugs waiting to bite as the workspace grows. Every time
      // someone fixes an active finding the test should stay green,
      // and a latent→active promotion (workspace grew past the
      // limit) should fire immediately.
      expect(
        run.summary.active,
        `list_* fuzz found ${run.summary.active} active hidden-pagination findings. See report above.`,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});
