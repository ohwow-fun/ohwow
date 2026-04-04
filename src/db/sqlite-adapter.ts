/**
 * SQLite Adapter
 *
 * Implements the DatabaseAdapter interface using better-sqlite3.
 * Translates the SupabaseClient-shaped query builder API into SQL queries
 * against a local SQLite database.
 *
 * Used by the local runtime for local data plane storage.
 */

import type Database from 'better-sqlite3';
import type {
  DatabaseAdapter,
  TableBuilder,
  SelectBuilder,
  InsertBuilder,
  UpdateBuilder,
  DeleteBuilder,
  FilterBuilder,
  DbResult,
  DbError,
} from './adapter-types.js';

// ============================================================================
// FILTER STATE
// ============================================================================

interface FilterState {
  table: string;
  conditions: Array<{ sql: string; params: unknown[] }>;
  orderClauses: string[];
  limitValue?: number;
  offsetValue?: number;
  rangeFrom?: number;
  rangeTo?: number;
}

// ============================================================================
// HELPERS
// ============================================================================

function makeError(message: string, code?: string): DbError {
  return { message, code };
}

function success<T>(data: T, count?: number | null): DbResult<T> {
  return { data, error: null, count };
}

function failure<T>(message: string, code?: string): DbResult<T> {
  return { data: null, error: makeError(message, code) };
}

/**
 * Parse Supabase-style .or() filter strings into SQL.
 * Example: "last_used_at.is.null,last_used_at.lt.2024-01-01"
 * Becomes: "(last_used_at IS NULL OR last_used_at < ?)"
 */
function parseOrFilter(filterString: string): { sql: string; params: unknown[] } {
  const parts = filterString.split(',');
  const clauses: string[] = [];
  const params: unknown[] = [];

  for (const part of parts) {
    const segments = part.trim().split('.');
    if (segments.length < 3) continue;

    const column = segments[0];
    const operator = segments[1];
    const value = segments.slice(2).join('.');

    switch (operator) {
      case 'eq':
        clauses.push(`${column} = ?`);
        params.push(value);
        break;
      case 'neq':
        clauses.push(`${column} != ?`);
        params.push(value);
        break;
      case 'gt':
        clauses.push(`${column} > ?`);
        params.push(value);
        break;
      case 'gte':
        clauses.push(`${column} >= ?`);
        params.push(value);
        break;
      case 'lt':
        clauses.push(`${column} < ?`);
        params.push(value);
        break;
      case 'lte':
        clauses.push(`${column} <= ?`);
        params.push(value);
        break;
      case 'is':
        if (value === 'null') {
          clauses.push(`${column} IS NULL`);
        } else if (value === 'true') {
          clauses.push(`${column} = 1`);
        } else if (value === 'false') {
          clauses.push(`${column} = 0`);
        }
        break;
      case 'ilike':
        clauses.push(`${column} LIKE ? COLLATE NOCASE`);
        params.push(value.replace(/%25/g, '%'));
        break;
      case 'like':
        clauses.push(`${column} LIKE ?`);
        params.push(value);
        break;
      case 'in':
        // in.(val1,val2,val3)
        {
          const inValues = value.replace(/^\(/, '').replace(/\)$/, '').split(',');
          clauses.push(`${column} IN (${inValues.map(() => '?').join(',')})`);
          params.push(...inValues);
        }
        break;
      default:
        clauses.push(`${column} ${operator} ?`);
        params.push(value);
    }
  }

  return {
    sql: `(${clauses.join(' OR ')})`,
    params,
  };
}

// ============================================================================
// QUERY BUILDER IMPLEMENTATION
// ============================================================================

function buildWhereClause(state: FilterState): { sql: string; params: unknown[] } {
  if (state.conditions.length === 0) {
    return { sql: '', params: [] };
  }

  const parts: string[] = [];
  const allParams: unknown[] = [];

  for (const cond of state.conditions) {
    parts.push(cond.sql);
    allParams.push(...cond.params);
  }

  return { sql: ` WHERE ${parts.join(' AND ')}`, params: allParams };
}

function buildOrderClause(state: FilterState): string {
  if (state.orderClauses.length === 0) return '';
  return ` ORDER BY ${state.orderClauses.join(', ')}`;
}

function buildLimitClause(state: FilterState): string {
  if (state.rangeFrom !== undefined && state.rangeTo !== undefined) {
    const count = state.rangeTo - state.rangeFrom + 1;
    return ` LIMIT ${count} OFFSET ${state.rangeFrom}`;
  }
  if (state.limitValue !== undefined) {
    const offset = state.offsetValue ? ` OFFSET ${state.offsetValue}` : '';
    return ` LIMIT ${state.limitValue}${offset}`;
  }
  return '';
}

/**
 * Parse JSON columns from SQLite rows.
 * SQLite stores JSON as text; we need to parse them back to objects.
 */
function parseJsonColumns(row: Record<string, unknown>): Record<string, unknown> {
  if (!row) return row;
  const result = { ...row };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string') {
      // Try to parse JSON strings (for jsonb columns)
      if ((value.startsWith('{') && value.endsWith('}')) ||
          (value.startsWith('[') && value.endsWith(']'))) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          // Not JSON, leave as string
        }
      }
    }
    // SQLite stores booleans as 0/1 — but we can't know which columns are boolean
    // without schema info. Leave this to the service layer.
  }
  return result;
}

function createFilterBuilder<T>(
  db: Database.Database,
  state: FilterState,
  mode: 'select' | 'insert' | 'update' | 'delete',
  selectColumns?: string,
  selectOptions?: { count?: 'exact'; head?: boolean },
  insertData?: unknown,
  updateData?: unknown,
): FilterBuilder<T> {
  const builder: FilterBuilder<T> = {
    eq(column: string, value: unknown) {
      state.conditions.push({ sql: `${column} = ?`, params: [value] });
      return builder;
    },
    neq(column: string, value: unknown) {
      state.conditions.push({ sql: `${column} != ?`, params: [value] });
      return builder;
    },
    gt(column: string, value: unknown) {
      state.conditions.push({ sql: `${column} > ?`, params: [value] });
      return builder;
    },
    gte(column: string, value: unknown) {
      state.conditions.push({ sql: `${column} >= ?`, params: [value] });
      return builder;
    },
    lt(column: string, value: unknown) {
      state.conditions.push({ sql: `${column} < ?`, params: [value] });
      return builder;
    },
    lte(column: string, value: unknown) {
      state.conditions.push({ sql: `${column} <= ?`, params: [value] });
      return builder;
    },
    in(column: string, values: unknown[]) {
      if (values.length === 0) {
        state.conditions.push({ sql: '1 = 0', params: [] }); // Always false
      } else {
        const placeholders = values.map(() => '?').join(', ');
        state.conditions.push({ sql: `${column} IN (${placeholders})`, params: values });
      }
      return builder;
    },
    is(column: string, value: null | boolean) {
      if (value === null) {
        state.conditions.push({ sql: `${column} IS NULL`, params: [] });
      } else {
        state.conditions.push({ sql: `${column} = ?`, params: [value ? 1 : 0] });
      }
      return builder;
    },
    or(filters: string) {
      const parsed = parseOrFilter(filters);
      state.conditions.push(parsed);
      return builder;
    },
    not(column: string, operator: string, value: unknown) {
      switch (operator) {
        case 'eq':
          state.conditions.push({ sql: `${column} != ?`, params: [value] });
          break;
        case 'is':
          if (value === null) {
            state.conditions.push({ sql: `${column} IS NOT NULL`, params: [] });
          }
          break;
        default:
          state.conditions.push({ sql: `NOT (${column} ${operator} ?)`, params: [value] });
      }
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }) {
      const dir = options?.ascending === false ? 'DESC' : 'ASC';
      state.orderClauses.push(`${column} ${dir}`);
      return builder;
    },
    limit(count: number) {
      state.limitValue = count;
      return builder;
    },
    range(from: number, to: number) {
      state.rangeFrom = from;
      state.rangeTo = to;
      return builder;
    },
    single() {
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then(onfulfilled?: ((value: any) => any) | null, onrejected?: ((reason: any) => any) | null) {
          try {
            const result = executeQuery<T>(db, state, mode, selectColumns, selectOptions, insertData, updateData);
            const rows = result.data as T[];

            if (!rows || (Array.isArray(rows) && rows.length === 0)) {
              const err = failure<T>('Row not found', 'PGRST116');
              return Promise.resolve(err).then(onfulfilled, onrejected);
            }

            if (Array.isArray(rows) && rows.length > 1) {
              const err = failure<T>('Multiple rows returned', 'PGRST116');
              return Promise.resolve(err).then(onfulfilled, onrejected);
            }

            const single = Array.isArray(rows) ? rows[0] : rows;
            return Promise.resolve(success(single as T, result.count)).then(onfulfilled, onrejected);
          } catch (e) {
            const err = failure<T>((e as Error).message);
            if (onrejected) return Promise.resolve(err).then(onfulfilled, onrejected);
            return Promise.resolve(err).then(onfulfilled);
          }
        },
      };
    },
    maybeSingle() {
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then(onfulfilled?: ((value: any) => any) | null, onrejected?: ((reason: any) => any) | null) {
          try {
            const result = executeQuery<T>(db, state, mode, selectColumns, selectOptions, insertData, updateData);
            const rows = result.data as T[];

            if (!rows || (Array.isArray(rows) && rows.length === 0)) {
              return Promise.resolve(success<T | null>(null, result.count)).then(onfulfilled, onrejected);
            }

            const single = Array.isArray(rows) ? rows[0] : rows;
            return Promise.resolve(success(single as T | null, result.count)).then(onfulfilled, onrejected);
          } catch (e) {
            const err = failure<T | null>((e as Error).message);
            return Promise.resolve(err).then(onfulfilled, onrejected);
          }
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then(onfulfilled?: ((value: any) => any) | null, onrejected?: ((reason: any) => any) | null) {
      try {
        const result = executeQuery<T>(db, state, mode, selectColumns, selectOptions, insertData, updateData);
        return Promise.resolve(result as DbResult<T[]>).then(onfulfilled, onrejected);
      } catch (e) {
        const err = failure<T[]>((e as Error).message);
        return Promise.resolve(err).then(onfulfilled, onrejected);
      }
    },
  };

  return builder;
}

function executeQuery<T>(
  db: Database.Database,
  state: FilterState,
  mode: 'select' | 'insert' | 'update' | 'delete',
  selectColumns?: string,
  selectOptions?: { count?: 'exact'; head?: boolean },
  insertData?: unknown,
  updateData?: unknown,
): DbResult<T[]> {
  const where = buildWhereClause(state);
  const order = buildOrderClause(state);
  const limit = buildLimitClause(state);

  switch (mode) {
    case 'select': {
      const cols = selectColumns || '*';
      const countOnly = selectOptions?.head === true;

      if (countOnly && selectOptions?.count === 'exact') {
        const countSql = `SELECT COUNT(*) as count FROM ${state.table}${where.sql}`;
        const row = db.prepare(countSql).get(...where.params) as { count: number };
        return { data: [] as T[], error: null, count: row.count };
      }

      const sql = `SELECT ${cols} FROM ${state.table}${where.sql}${order}${limit}`;
      let rows = db.prepare(sql).all(...where.params) as T[];
      rows = rows.map(r => parseJsonColumns(r as Record<string, unknown>) as T);

      let count: number | null = null;
      if (selectOptions?.count === 'exact') {
        const countSql = `SELECT COUNT(*) as count FROM ${state.table}${where.sql}`;
        const countRow = db.prepare(countSql).get(...where.params) as { count: number };
        count = countRow.count;
      }

      return { data: rows, error: null, count };
    }

    case 'insert': {
      const rows = Array.isArray(insertData) ? insertData : [insertData];
      const results: T[] = [];

      const insertRow = (row: unknown) => {
        const record = row as Record<string, unknown>;
        const columns = Object.keys(record);
        const values = columns.map(col => {
          const v = record[col];
          // Serialize objects/arrays to JSON for storage
          if (v !== null && typeof v === 'object') return JSON.stringify(v);
          return v;
        });
        const placeholders = columns.map(() => '?').join(', ');

        const sql = `INSERT INTO ${state.table} (${columns.join(', ')}) VALUES (${placeholders})`;
        db.prepare(sql).run(...values);

        // If we need to return the inserted row, select it back
        // Use last_insert_rowid() to get the row
        const lastId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
        const inserted = db.prepare(`SELECT * FROM ${state.table} WHERE rowid = ?`).get(lastId.id) as T;
        if (inserted) {
          results.push(parseJsonColumns(inserted as Record<string, unknown>) as T);
        }
      };

      // Wrap multi-row inserts in a transaction for 10-100x better performance
      if (rows.length > 1) {
        const batchInsert = db.transaction((batchRows: unknown[]) => {
          for (const row of batchRows) {
            insertRow(row);
          }
        });
        batchInsert(rows);
      } else {
        insertRow(rows[0]);
      }

      return { data: results, error: null };
    }

    case 'update': {
      const record = updateData as Record<string, unknown>;
      const columns = Object.keys(record);
      const setClauses = columns.map(col => `${col} = ?`).join(', ');
      const setValues = columns.map(col => {
        const v = record[col];
        if (v !== null && typeof v === 'object') return JSON.stringify(v);
        return v;
      });

      const sql = `UPDATE ${state.table} SET ${setClauses}${where.sql}`;
      db.prepare(sql).run(...setValues, ...where.params);

      // Return updated rows
      const selectSql = `SELECT * FROM ${state.table}${where.sql}${order}${limit}`;
      let rows = db.prepare(selectSql).all(...where.params) as T[];
      rows = rows.map(r => parseJsonColumns(r as Record<string, unknown>) as T);

      return { data: rows, error: null };
    }

    case 'delete': {
      const sql = `DELETE FROM ${state.table}${where.sql}`;
      db.prepare(sql).run(...where.params);
      return { data: [] as T[], error: null };
    }
  }
}

// ============================================================================
// SQLITE ADAPTER
// ============================================================================

/**
 * Map of registered RPC functions for the SQLite adapter.
 * In Supabase, .rpc() calls server-side Postgres functions.
 * In SQLite, we register JS functions that perform the same logic.
 */
type RpcHandler = (params: Record<string, unknown>) => unknown;

export interface SqliteAdapterOptions {
  rpcHandlers?: Record<string, RpcHandler>;
}

export function createSqliteAdapter(
  db: Database.Database,
  options?: SqliteAdapterOptions,
): DatabaseAdapter {
  const rpcHandlers = options?.rpcHandlers ?? {};

  return {
    from<T = Record<string, unknown>>(table: string): TableBuilder<T> {
      return {
        select(columns?: string, selectOptions?: { count?: 'exact'; head?: boolean }): SelectBuilder<T> {
          const state: FilterState = {
            table,
            conditions: [],
            orderClauses: [],
          };
          return createFilterBuilder<T>(db, state, 'select', columns, selectOptions) as SelectBuilder<T>;
        },

        insert(data: Partial<T> | Partial<T>[]): InsertBuilder<T> {
          const state: FilterState = {
            table,
            conditions: [],
            orderClauses: [],
          };
          const insertBuilder: InsertBuilder<T> = {
            select(columns?: string) {
              return createFilterBuilder<T>(db, state, 'insert', columns, undefined, data);
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            then(onfulfilled?: ((value: any) => any) | null, onrejected?: ((reason: any) => any) | null) {
              try {
                const result = executeQuery<T>(db, state, 'insert', undefined, undefined, data);
                return Promise.resolve({ data: null, error: result.error } as DbResult<null>).then(onfulfilled, onrejected);
              } catch (e) {
                const err = failure<null>((e as Error).message);
                return Promise.resolve(err).then(onfulfilled, onrejected);
              }
            },
          };
          return insertBuilder;
        },

        update(data: Partial<T>): UpdateBuilder<T> {
          const state: FilterState = {
            table,
            conditions: [],
            orderClauses: [],
          };
          const fb = createFilterBuilder<T>(db, state, 'update', undefined, undefined, undefined, data);
          const updateBuilder = fb as UpdateBuilder<T>;
          (updateBuilder as UpdateBuilder<T> & { select: (columns?: string) => FilterBuilder<T> }).select = (columns?: string) => {
            return createFilterBuilder<T>(db, state, 'update', columns, undefined, undefined, data);
          };
          return updateBuilder;
        },

        delete(): DeleteBuilder<T> {
          const state: FilterState = {
            table,
            conditions: [],
            orderClauses: [],
          };
          return createFilterBuilder<T>(db, state, 'delete') as DeleteBuilder<T>;
        },
      };
    },

    rpc<T = unknown>(fn: string, params?: Record<string, unknown>): PromiseLike<DbResult<T>> {
      const handler = rpcHandlers[fn];
      if (!handler) {
        return Promise.resolve(failure<T>(`RPC function '${fn}' not registered`));
      }
      try {
        const result = handler(params ?? {});
        return Promise.resolve(success(result as T));
      } catch (e) {
        return Promise.resolve(failure<T>((e as Error).message));
      }
    },
  };
}
