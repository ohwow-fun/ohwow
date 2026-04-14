#!/usr/bin/env tsx
/**
 * One-shot diagnostic for ContentCadenceLoopHealthExperiment.
 *
 * Opens the live workspace SQLite database read-only, builds a minimal
 * ExperimentContext, runs the watcher's probe + judge, and prints the
 * evidence + verdict as JSON. Tells you what the watcher would say
 * RIGHT NOW about the closed loop, without waiting for the next 1-hour
 * tick or restarting the daemon.
 *
 * Usage:
 *   npm run probe-loop-health                # default workspace
 *   npm run probe-loop-health -- avenued     # specific workspace
 *
 * Read-only: the probe only does SELECTs. Safe to run against the live
 * DB while the daemon is connected — SQLite WAL mode supports parallel
 * readers without locking the writer.
 */

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { ContentCadenceLoopHealthExperiment } from '../src/self-bench/experiments/content-cadence-loop-health.js';
import { readRecentFindings } from '../src/self-bench/findings-store.js';
import type { ExperimentContext } from '../src/self-bench/experiment-types.js';
import type { RuntimeEngine } from '../src/execution/engine.js';

async function main() {
  const workspaceSlug = process.argv[2] ?? 'default';
  const dbPath = join(homedir(), '.ohwow', 'workspaces', workspaceSlug, 'runtime.db');

  if (!existsSync(dbPath)) {
    console.error(`error: workspace DB not found at ${dbPath}`);
    process.exit(1);
  }

  // Open read-only — daemon may be writing concurrently.
  const rawDb = new Database(dbPath, { readonly: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createSqliteAdapter(rawDb as any);

  // The watcher reads agent_workforce_goals scoped by workspace_id, which
  // is the consolidated cloud UUID (or 'local' sentinel) post-boot.
  // agent_workforce_workspaces has no slug column, so we pick the
  // UUID-shaped row (cloud-consolidated) when present, otherwise 'local'.
  // This matches the runtime's resolution order.
  const wsRows = rawDb
    .prepare('SELECT id FROM agent_workforce_workspaces')
    .all() as Array<{ id: string }>;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const cloudRow = wsRows.find((r) => uuidRe.test(r.id));
  const localRow = wsRows.find((r) => r.id === 'local');
  const wsRow = cloudRow ?? localRow;

  if (!wsRow) {
    console.error(
      `error: no rows in agent_workforce_workspaces — daemon may not have booted this workspace yet`,
    );
    rawDb.close();
    process.exit(1);
  }

  const ctx: ExperimentContext = {
    db,
    workspaceId: wsRow.id,
    workspaceSlug,
    // The probe doesn't use engine; pass a stub so the type checks.
    engine: {} as unknown as RuntimeEngine,
    recentFindings: (experimentId, limit) => readRecentFindings(db, experimentId, limit),
  };

  const exp = new ContentCadenceLoopHealthExperiment();
  const result = await exp.probe(ctx);
  const verdict = exp.judge(result, []);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        workspace: { slug: workspaceSlug, id: wsRow.id },
        verdict,
        summary: result.summary,
        subject: result.subject,
        evidence: result.evidence,
      },
      null,
      2,
    ),
  );

  rawDb.close();
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
