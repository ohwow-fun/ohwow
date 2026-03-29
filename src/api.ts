/**
 * ohwow — Public API
 *
 * Side-effect-free entry point for programmatic consumers.
 * The CLI entry point is in index.ts (used by bin/ohwow.js).
 */

export { createSqliteAdapter } from './db/sqlite-adapter.js';
export type { SqliteAdapterOptions } from './db/sqlite-adapter.js';
