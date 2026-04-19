#!/usr/bin/env tsx
/**
 * Runtime → cloud bulk sync CLI (Trio 2 of the 5-trio sync arc).
 *
 * One-shot script that streams rows from a single registered SQLite
 * table to its cloud Postgres mirror via INSERT … ON CONFLICT … DO
 * UPDATE upserts. Honors per-(workspace, table) opt-outs from the
 * cloud workspace_sync_config table for workspace-scoped specs.
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

import Database from 'better-sqlite3';
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { logger } from '../src/lib/logger.js';
import { resolveActiveWorkspace, workspaceLayoutFor } from '../src/config.js';
import { getSpec, listTables, type SyncTableSpec } from '../src/sync/registry.js';

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

/** Read workspace_sync_config once into a (workspace_id → enabled) map. */
async function loadOptOutMap(client: pg.Client, table: string): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  try {
    const r = await client.query<{ workspace_id: string; enabled: boolean }>(
      'SELECT workspace_id::text, enabled FROM public.workspace_sync_config WHERE table_name = $1',
      [table],
    );
    for (const row of r.rows) map.set(row.workspace_id, row.enabled);
  } catch (err) {
    logger.warn({ err }, '[sync] workspace_sync_config not readable; assuming default-on');
  }
  return map;
}

function buildUpsertSql(spec: SyncTableSpec): string {
  const cloudTable = spec.cloudTable || spec.table;
  const cols = spec.columns;
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
  const updateAssigns = cols
    .filter((c) => c !== spec.primaryKey)
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  return (
    `INSERT INTO public.${cloudTable} (${cols.join(',')}) VALUES (${placeholders}) ` +
    `ON CONFLICT (${spec.primaryKey}) DO UPDATE SET ${updateAssigns}`
  );
}

/**
 * Coerce a SQLite row value into a shape the pg driver accepts. The two
 * promotions that bite v1: TEXT(JSON) columns must be sent as parsed JS
 * (pg serializes back to jsonb) and TEXT(datetime) must remain a string
 * because pg accepts ISO-ish strings into timestamptz natively.
 */
function coerceValue(col: string, val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (col.endsWith('_json') && typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
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

  const db = new Database(sqlitePath, { readonly: true });
  const client = new pg.Client({ connectionString: cloudUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const startMs = Date.now();
  let read = 0;
  let wrote = 0;
  let skippedOptout = 0;

  try {
    const optoutMap = spec.isWorkspaceScoped ? await loadOptOutMap(client, spec.table) : new Map<string, boolean>();
    const upsertSql = buildUpsertSql(spec);
    const whereClause = args.workspace ? `WHERE workspace_id = ?` : '';
    const selectSql = `SELECT ${spec.columns.join(',')} FROM ${spec.table} ${whereClause}`.trim();

    if (args.dryRun) {
      const countRow = db
        .prepare(`SELECT COUNT(*) AS n FROM ${spec.table} ${whereClause}`)
        .get(...(args.workspace ? [args.workspace] : [])) as { n: number };
      logger.info({ wouldProcess: countRow.n, selectSql, upsertSql }, '[sync] dry-run plan');
      read = countRow.n;
    } else {
      const stmt = db.prepare(selectSql);
      const iter = args.workspace ? stmt.iterate(args.workspace) : stmt.iterate();
      let batch: unknown[][] = [];
      for (const row of iter as IterableIterator<Record<string, unknown>>) {
        read++;
        if (spec.isWorkspaceScoped) {
          const wsId = String(row.workspace_id ?? '');
          if (optoutMap.get(wsId) === false) {
            skippedOptout++;
            continue;
          }
        }
        batch.push(spec.columns.map((c) => coerceValue(c, row[c])));
        if (batch.length >= args.batchSize) {
          wrote += await flushBatch(client, upsertSql, batch);
          batch = [];
        }
      }
      if (batch.length > 0) {
        wrote += await flushBatch(client, upsertSql, batch);
      }
    }
  } finally {
    db.close();
    await client.end();
  }

  const durationMs = Date.now() - startMs;
  logger.info({ read, wrote, skippedOptout, durationMs }, '[sync] done');
  // eslint-disable-next-line no-console
  console.log(`read=${read} wrote=${wrote} skipped_optout=${skippedOptout} duration_ms=${durationMs}`);
}

async function flushBatch(client: pg.Client, sql: string, batch: unknown[][]): Promise<number> {
  let n = 0;
  for (const params of batch) {
    await client.query(sql, params);
    n++;
  }
  return n;
}

main().then(
  () => process.exit(0),
  (err) => {
    logger.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err }, '[sync] failed');
    process.exit(1);
  },
);
