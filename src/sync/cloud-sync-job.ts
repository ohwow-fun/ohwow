/**
 * Runtime → cloud bulk sync job (daemon cron).
 *
 * Extracts the core sync loop from scripts/sync-runtime-to-cloud.ts into
 * a reusable async function that the daemon scheduling cron can call every
 * N minutes. The CLI script becomes a thin wrapper around this.
 *
 * Key design decisions:
 * - Opens a fresh pg.Client per call; closes it on return.
 * - Never throws on pg connection failure — returns [] and warns.
 * - Honors per-(workspace, table) opt-outs from workspace_sync_config.
 * - Processes ALL tables in SYNC_REGISTRY for the given workspaceId.
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import { logger } from '../lib/logger.js';
import { SYNC_REGISTRY, type SyncTableSpec } from './registry.js';

export interface SyncTableResult {
  table: string;
  read: number;
  wrote: number;
}

export interface SyncAllTablesOpts {
  workspaceId: string;
  sqlitePath: string;
  cloudDatabaseUrl: string;
  dryRun?: boolean;
  batchSize?: number;
}

/**
 * Coerce a SQLite row value into a shape the pg driver accepts. TEXT(JSON)
 * columns must be sent as parsed JS (pg serializes back to jsonb); TEXT
 * datetime columns remain strings (pg accepts ISO-ish into timestamptz).
 */
export function coerceValue(col: string, val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (col.endsWith('_json') && typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return JSON.stringify(parsed);
      return parsed;
    } catch {
      return val;
    }
  }
  return val;
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

async function flushBatch(client: pg.Client, sql: string, batch: unknown[][]): Promise<number> {
  let n = 0;
  for (const params of batch) {
    await client.query(sql, params);
    n++;
  }
  return n;
}

async function syncTable(
  db: InstanceType<typeof Database>,
  client: pg.Client,
  spec: SyncTableSpec,
  workspaceId: string,
  batchSize: number,
  dryRun: boolean,
): Promise<SyncTableResult> {
  const result: SyncTableResult = { table: spec.table, read: 0, wrote: 0 };

  const optoutMap = spec.isWorkspaceScoped
    ? await loadOptOutMap(client, spec.table)
    : new Map<string, boolean>();

  const upsertSql = buildUpsertSql(spec);

  let selectSql: string;
  let bindParams: unknown[];

  if (spec.parentJoin) {
    const { parentTable, parentColumn, childColumn, parentWorkspaceColumn } = spec.parentJoin;
    const cols = spec.columns.map((c) => `child.${c}`).join(', ');
    selectSql =
      `SELECT ${cols} FROM ${spec.table} child ` +
      `JOIN ${parentTable} parent ON parent.${parentColumn} = child.${childColumn} ` +
      `WHERE parent.${parentWorkspaceColumn} = ?`;
    bindParams = [workspaceId];
  } else if (spec.isWorkspaceScoped) {
    selectSql = `SELECT ${spec.columns.join(', ')} FROM ${spec.table} WHERE workspace_id = ?`;
    bindParams = [workspaceId];
  } else {
    selectSql = `SELECT ${spec.columns.join(', ')} FROM ${spec.table}`;
    bindParams = [];
  }

  if (dryRun) {
    let countSql: string;
    let countParams: unknown[];
    if (spec.parentJoin) {
      const { parentTable, parentColumn, childColumn, parentWorkspaceColumn } = spec.parentJoin;
      countSql =
        `SELECT COUNT(*) AS n FROM ${spec.table} child ` +
        `JOIN ${parentTable} parent ON parent.${parentColumn} = child.${childColumn} ` +
        `WHERE parent.${parentWorkspaceColumn} = ?`;
      countParams = [workspaceId];
    } else if (spec.isWorkspaceScoped) {
      countSql = `SELECT COUNT(*) AS n FROM ${spec.table} WHERE workspace_id = ?`;
      countParams = [workspaceId];
    } else {
      countSql = `SELECT COUNT(*) AS n FROM ${spec.table}`;
      countParams = [];
    }
    const countRow = db.prepare(countSql).get(...countParams) as { n: number };
    result.read = countRow.n;
    return result;
  }

  const stmt = db.prepare(selectSql);
  const iter = (bindParams.length > 0 ? stmt.iterate(...bindParams) : stmt.iterate()) as IterableIterator<Record<string, unknown>>;
  let batch: unknown[][] = [];

  for (const row of iter) {
    result.read++;
    if (spec.isWorkspaceScoped) {
      const wsId = spec.parentJoin
        ? workspaceId
        : String((row as Record<string, unknown>).workspace_id ?? '');
      if (optoutMap.get(wsId) === false) continue;
    }
    batch.push(spec.columns.map((c) => coerceValue(c, row[c])));
    if (batch.length >= batchSize) {
      result.wrote += await flushBatch(client, upsertSql, batch);
      batch = [];
    }
  }
  if (batch.length > 0) {
    result.wrote += await flushBatch(client, upsertSql, batch);
  }

  return result;
}

/**
 * Sync all registered tables for the given workspace to cloud Postgres.
 *
 * Opens one pg connection, iterates SYNC_REGISTRY, and returns per-table
 * stats. Never throws — catches pg connection failure and returns [].
 */
export async function syncAllTables(opts: SyncAllTablesOpts): Promise<SyncTableResult[]> {
  const { workspaceId, sqlitePath, cloudDatabaseUrl, dryRun = false, batchSize = 500 } = opts;

  if (!cloudDatabaseUrl) {
    logger.warn('[sync] cloudDatabaseUrl is empty; skipping sync');
    return [];
  }

  const client = new pg.Client({ connectionString: cloudDatabaseUrl, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
  } catch (err) {
    logger.warn({ err }, '[sync] pg connection failed; skipping sync');
    return [];
  }

  let db: InstanceType<typeof Database> | null = null;
  const results: SyncTableResult[] = [];

  try {
    db = new Database(sqlitePath, { readonly: true });

    for (const spec of SYNC_REGISTRY) {
      try {
        const tableResult = await syncTable(db, client, spec, workspaceId, batchSize, dryRun);
        results.push(tableResult);
        logger.debug(
          { table: spec.table, read: tableResult.read, wrote: tableResult.wrote, dryRun },
          '[sync] table done',
        );
      } catch (err) {
        logger.warn({ err, table: spec.table }, '[sync] table sync error; skipping');
      }
    }
  } catch (err) {
    logger.warn({ err }, '[sync] sqlite open failed; skipping sync');
    return [];
  } finally {
    db?.close();
    await client.end().catch(() => { /* best-effort close */ });
  }

  return results;
}
