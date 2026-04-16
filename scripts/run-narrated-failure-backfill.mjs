#!/usr/bin/env node
/**
 * One-off runner for backfillNarratedFailures against a workspace's
 * runtime.db. Usage:
 *
 *   node scripts/run-narrated-failure-backfill.mjs                 # dry-run (default)
 *   node scripts/run-narrated-failure-backfill.mjs --apply         # reroute rows to failed
 *   node scripts/run-narrated-failure-backfill.mjs --since=2026-04-01T00:00:00Z
 *
 * Calls the same primitive the runtime exposes from
 * src/execution/narrated-failure-backfill.ts. Uses tsx under the hood
 * so we can import TypeScript directly without a separate build.
 */
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.ts';
import { backfillNarratedFailures } from '../src/execution/narrated-failure-backfill.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sinceFlag = args.find((a) => a.startsWith('--since='));
const since = sinceFlag ? sinceFlag.split('=')[1] : undefined;

const workspaceArg = args.find((a) => a.startsWith('--workspace='));
const workspace = workspaceArg ? workspaceArg.split('=')[1] : 'default';
const dbPath = path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'runtime.db');

console.log(`[backfill] workspace=${workspace} dbPath=${dbPath} apply=${apply}${since ? ` since=${since}` : ''}`);

const raw = new Database(dbPath);
const db = createSqliteAdapter(raw);

const result = await backfillNarratedFailures(db, { dryRun: !apply, since });
raw.close();

console.log(`\n[backfill] scanned=${result.scanned} flagged=${result.flagged.length} applied=${result.applied}`);
if (result.flagged.length > 0) {
  const byType = {};
  const byCanary = {};
  for (const hit of result.flagged) {
    byType[hit.action_type] = (byType[hit.action_type] ?? 0) + 1;
    byCanary[hit.canary] = (byCanary[hit.canary] ?? 0) + 1;
  }
  console.log('\nby_action_type:', JSON.stringify(byType, null, 2));
  console.log('\nby_canary (top 10):');
  const topCanaries = Object.entries(byCanary).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [c, n] of topCanaries) console.log(`  ${n.toString().padStart(3)}  ${c}`);

  console.log(`\nFirst 5 flagged rows (${apply ? 'rerouted' : 'would reroute'}):`);
  for (const hit of result.flagged.slice(0, 5)) {
    console.log(`  - ${hit.task_id}  ${hit.completed_at ?? '?'}  canary="${hit.canary}"`);
    console.log(`    preview: ${hit.output_preview.slice(0, 120).replace(/\n/g, ' ')}`);
  }
}

if (!apply && result.flagged.length > 0) {
  console.log(`\nRe-run with --apply to reroute ${result.flagged.length} rows to status=failed.`);
}
