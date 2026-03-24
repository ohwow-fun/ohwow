/**
 * DatabaseAdapter Interface (Runtime Copy)
 *
 * Abstracts the query builder pattern used by Supabase's PostgREST client.
 * Both the Supabase adapter (cloud) and SQLite adapter (local runtime)
 * implement this interface, allowing all agent services to work with either backend.
 *
 * Mirrors the SupabaseClient chaining API: .from(table).select().eq().single()
 */

// ============================================================================
// RESULT TYPES
// ============================================================================

export interface DbResult<T> {
  data: T | null;
  error: DbError | null;
  count?: number | null;
}

export interface DbError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

// ============================================================================
// QUERY BUILDER INTERFACES
// ============================================================================

export interface FilterBuilder<T> {
  eq(column: string, value: unknown): FilterBuilder<T>;
  neq(column: string, value: unknown): FilterBuilder<T>;
  gt(column: string, value: unknown): FilterBuilder<T>;
  gte(column: string, value: unknown): FilterBuilder<T>;
  lt(column: string, value: unknown): FilterBuilder<T>;
  lte(column: string, value: unknown): FilterBuilder<T>;
  in(column: string, values: unknown[]): FilterBuilder<T>;
  is(column: string, value: null | boolean): FilterBuilder<T>;
  or(filters: string, options?: { foreignTable?: string }): FilterBuilder<T>;
  not(column: string, operator: string, value: unknown): FilterBuilder<T>;

  order(column: string, options?: { ascending?: boolean }): FilterBuilder<T>;
  limit(count: number): FilterBuilder<T>;
  range(from: number, to: number): FilterBuilder<T>;

  single(): PromiseLike<DbResult<T>>;
  maybeSingle(): PromiseLike<DbResult<T | null>>;
  then<TResult1 = DbResult<T[]>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<T[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2>;
}

export type SelectBuilder<T> = FilterBuilder<T>;

export interface InsertBuilder<T> {
  select(columns?: string): FilterBuilder<T>;
  then<TResult1 = DbResult<null>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<null>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2>;
}

export interface UpdateBuilder<T> extends FilterBuilder<T> {
  eq(column: string, value: unknown): UpdateBuilder<T>;
  neq(column: string, value: unknown): UpdateBuilder<T>;
  select(columns?: string): FilterBuilder<T>;
}

export type DeleteBuilder<T> = FilterBuilder<T>;

export interface TableBuilder<T = Record<string, unknown>> {
  select(columns?: string, options?: { count?: 'exact'; head?: boolean }): SelectBuilder<T>;
  insert(data: Partial<T> | Partial<T>[]): InsertBuilder<T>;
  update(data: Partial<T>): UpdateBuilder<T>;
  delete(): DeleteBuilder<T>;
}

// ============================================================================
// DATABASE ADAPTER
// ============================================================================

export interface DatabaseAdapter {
  from<T = Record<string, unknown>>(table: string): TableBuilder<T>;
  rpc<T = unknown>(fn: string, params?: Record<string, unknown>): PromiseLike<DbResult<T>>;
}
