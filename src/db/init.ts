/**
 * SQLite Database Initialization
 *
 * Opens the SQLite database and runs migrations in order.
 * Tracks applied migrations in a `schema_migrations` table so each
 * migration only runs once.
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../lib/logger.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Initialize the SQLite database:
 * 1. Ensure the parent directory exists
 * 2. Open (or create) the database file
 * 3. Enable WAL mode for better concurrent read performance
 * 4. Run all migrations in order
 */
export function initDatabase(dbPath: string): Database.Database {
  // Ensure directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Performance settings for local runtime
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Run migrations
  runMigrations(db);

  return db;
}

/**
 * Run pending SQL migration files in the migrations/ directory.
 * Files are sorted by name (001-xxx.sql, 002-xxx.sql, etc.).
 * A `schema_migrations` table tracks which files have already been applied.
 */
function runMigrations(db: Database.Database): void {
  const migrationsDir = join(__dirname, 'migrations');

  if (!existsSync(migrationsDir)) {
    logger.warn('[DB] No migrations directory found at %s', migrationsDir);
    return;
  }

  // Ensure the tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Bootstrap: if the DB already has tables but schema_migrations is empty,
  // this is a pre-existing database. Mark all current migrations as applied.
  const migrationCount = (db.prepare('SELECT COUNT(*) as n FROM schema_migrations').get() as { n: number }).n;
  if (migrationCount === 0) {
    const hasExistingTables = (db.prepare(
      "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name != 'schema_migrations'"
    ).get() as { n: number }).n > 0;

    if (hasExistingTables) {
      const allFiles = readdirSync(migrationsDir).filter((f: string) => f.endsWith('.sql')).sort();
      const backfill = db.transaction(() => {
        for (const file of allFiles) {
          db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
        }
      });
      backfill();
      return;
    }
  }

  // Determine which migrations have already been applied
  const rows = db.prepare('SELECT filename FROM schema_migrations').all() as { filename: string }[];
  const applied = new Set(rows.map((r) => r.filename));

  // Read and sort migration files
  const files = readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return;

  // Run pending migrations in a single transaction
  const runAll = db.transaction(() => {
    for (const file of pending) {
      const filePath = join(migrationsDir, file);
      const sql = readFileSync(filePath, 'utf-8');

      // Split on lines starting with "-- @statement" to execute ALTER statements individually
      // (ALTER TABLE fails if column already exists — we swallow those errors)
      const statements = sql.split(/^-- @statement$/m);
      if (statements.length > 1) {
        // First chunk is always the main CREATE statements
        db.exec(statements[0]);
        // Remaining chunks are individual statements that may fail idempotently
        for (let i = 1; i < statements.length; i++) {
          const stmt = statements[i].trim();
          if (!stmt) continue;
          try {
            db.exec(stmt);
          } catch {
            // Swallow errors (e.g. "duplicate column name") for idempotent ALTER TABLE
          }
        }
      } else {
        db.exec(sql);
      }

      // Record this migration as applied
      db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    }
  });

  runAll();
}
