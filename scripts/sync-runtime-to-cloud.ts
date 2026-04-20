#!/usr/bin/env tsx
/**
 * Runtime → cloud bulk sync CLI (Trio 2 of the 5-trio sync arc).
 *
 * Thin wrapper around src/sync/cloud-sync-job.ts — parses CLI args,
 * resolves paths/URL, calls syncAllTables() filtered to a single table,
 * and logs results. The core loop lives in the shared module so the
 * daemon cron can reuse it without spawning a subprocess.
 *
 * Usage:
 *   npx tsx scripts/sync-runtime-to-cloud.ts <table> [--workspace <uuid>] [--dry-run] [--batch-size N]
 *
 * Environment:
 *   OHWOW_CLOUD_DATABASE_URL  preferred, explicit Postgres URI
 *   (fallback) walks up from cwd for ohwow.fun/.env.local DATABASE_URL
 *
 * Distinct from src/control-plane/sync-resources.ts (event-driven, per
 * tool execution). This is the manual backfill + verification path.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../src/lib/logger.js';
import { resolveActiveWorkspace, workspaceLayoutFor } from '../src/config.js';
import { getSpec, listTables } from '../src/sync/registry.js';
import { syncAllTables } from '../src/sync/cloud-sync-job.js';

interface CliArgs {
  table: string;
  workspace?: string;
  dryRun: boolean;
  batchSize: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { dryRun: false, batchSize: 500 };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--workspace') args.workspace = argv[++i];
    else if (a === '--batch-size') args.batchSize = parseInt(argv[++i] || '500', 10);
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length === 0) {
    printUsage();
    throw new Error('Missing required <table> positional arg');
  }
  return {
    table: positional[0],
    workspace: args.workspace,
    dryRun: args.dryRun ?? false,
    batchSize: args.batchSize ?? 500,
  };
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.error(
    `Usage: sync-runtime-to-cloud <table> [--workspace <uuid>] [--dry-run] [--batch-size N]\n` +
      `Registered tables: ${listTables().join(', ')}`,
  );
}

/**
 * Resolve the runtime SQLite path. Always sources from the active
 * workspace pointer (~/.ohwow/current-workspace) — the --workspace CLI
 * flag is a CLOUD workspace_id row filter, not a runtime workspace
 * picker. To target a different runtime DB, set OHWOW_WORKSPACE in the
 * env (resolveActiveWorkspace honors it).
 */
function resolveSqlitePath(): string {
  const active = resolveActiveWorkspace();
  if (existsSync(active.dbPath)) return active.dbPath;
  // Fallback: the daemon may still hold the legacy single-workspace path.
  const legacy = workspaceLayoutFor('default');
  if (existsSync(legacy.dbPath)) return legacy.dbPath;
  throw new Error(
    `Runtime SQLite not found at ${active.dbPath} (workspace=${active.name}); ` +
      `set OHWOW_WORKSPACE to target a different runtime workspace`,
  );
}

/** Resolve the cloud Postgres URI: env var first, then walk up for ohwow.fun/.env.local. */
function resolveCloudUrl(): string {
  const fromEnv = process.env.OHWOW_CLOUD_DATABASE_URL;
  if (fromEnv) return fromEnv;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'ohwow.fun', '.env.local');
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, 'utf-8');
      const m = raw.match(/^DATABASE_URL=(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'No cloud DB URL: set OHWOW_CLOUD_DATABASE_URL or place ohwow.fun/.env.local with DATABASE_URL=',
  );
}

/** Mask password segment of a Postgres URI for logs. */
function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    return '<unparseable>';
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const spec = getSpec(args.table);
  if (!spec) {
    throw new Error(`Table '${args.table}' not in SYNC_REGISTRY. Registered: ${listTables().join(', ')}`);
  }

  const sqlitePath = resolveSqlitePath();
  const cloudUrl = resolveCloudUrl();
  const cloudHost = safeHost(cloudUrl);

  logger.info(
    {
      table: spec.table,
      cloudTable: spec.cloudTable || spec.table,
      sqlitePath,
      cloudHost,
      dryRun: args.dryRun,
      batchSize: args.batchSize,
      notes: spec.notes,
    },
    '[sync] starting',
  );

  const startMs = Date.now();

  // syncAllTables processes all registry tables; we filter to just the one
  // the CLI requested. The workspaceId for CLI is the --workspace flag value
  // (cloud workspace_id used as a row filter). If not provided, we use an
  // empty string — syncAllTables will skip workspace_id filtering for
  // non-workspace-scoped tables, and workspace-scoped tables will receive
  // all rows (since isWorkspaceScoped tables filter by the provided id,
  // and '' won't match any workspace_id, resulting in 0 reads for scoped tables).
  // For full-table backfill without --workspace, callers should omit the flag
  // and the WHERE clause is skipped per syncTable's isWorkspaceScoped logic.
  const workspaceId = args.workspace ?? '';

  const results = await syncAllTables({
    workspaceId,
    sqlitePath,
    cloudDatabaseUrl: cloudUrl,
    dryRun: args.dryRun,
    batchSize: args.batchSize,
  });

  const tableResult = results.find((r) => r.table === args.table);
  const read = tableResult?.read ?? 0;
  const wrote = tableResult?.wrote ?? 0;
  const durationMs = Date.now() - startMs;

  logger.info({ read, wrote, durationMs }, '[sync] done');
  // eslint-disable-next-line no-console
  console.log(`read=${read} wrote=${wrote} duration_ms=${durationMs}`);
}

// Only run as CLI when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(0),
    (err) => {
      logger.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err }, '[sync] failed');
      process.exit(1);
    },
  );
}
