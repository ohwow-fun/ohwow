#!/usr/bin/env node
/**
 * Deterministic generator for src/self-bench/registries/migration-schema-registry.ts.
 *
 * Parses every src/db/migrations/*.sql file, computes the set of tables
 * each migration produces (CREATE/DROP/ALTER...RENAME TO), walks the
 * migrations in numerical order, and emits one registry row per migration
 * whose tables aren't already claimed by an earlier migration. The first
 * migration to CREATE a table wins. Rename-in-place migrations (e.g. 027,
 * 032, 044, 083) yield no novel tables and are silently skipped.
 *
 * Retires what used to be autonomous-loop work: the experiment-author
 * was burning one commit per new migration to append a row here. That is
 * purely mechanical. Running this script (or the repo's pre-commit check)
 * keeps the registry in lockstep with the migrations directory without
 * spending an LLM tick.
 *
 * Exit codes:
 *   0  registry file written (or --check mode: output matches tracked)
 *   1  --check mode and tracked file is stale (or IO error)
 *
 * Usage:
 *   node scripts/regen-migration-schema-registry.mjs          # write file
 *   node scripts/regen-migration-schema-registry.mjs --check  # diff mode
 *   node scripts/regen-migration-schema-registry.mjs --print  # stdout only
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'src', 'db', 'migrations');
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  'src',
  'self-bench',
  'registries',
  'migration-schema-registry.ts',
);

const MIGRATION_MAX_TABLES_PER_PROBE = 50;

/**
 * Simulate a migration file's effect on the table set, in document order.
 * Case-insensitive, tolerates whitespace variation, dedupes within one
 * file, preserves order of first appearance. Mirrors the regex used
 * by ExperimentProposalGenerator.computeFinalTables so the generated
 * registry agrees with the proposal generator's view of the world.
 */
function computeFinalTables(sqlContent) {
  const re = /(?:create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][a-zA-Z0-9_]*))|(?:drop\s+table\s+(?:if\s+exists\s+)?([a-zA-Z_][a-zA-Z0-9_]*))|(?:alter\s+table\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+rename\s+to\s+([a-zA-Z_][a-zA-Z0-9_]*))/gi;
  const tables = new Map();
  let m;
  while ((m = re.exec(sqlContent)) !== null) {
    if (m[1]) {
      tables.set(m[1], true);
    } else if (m[2]) {
      tables.delete(m[2]);
    } else if (m[3] && m[4]) {
      if (tables.has(m[3])) {
        tables.delete(m[3]);
        tables.set(m[4], true);
      } else {
        tables.set(m[4], true);
      }
    }
  }
  return [...tables.keys()];
}

function buildRegistry() {
  const entries = fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
  // Natural ascending by filename. Zero-padded numeric prefixes sort
  // correctly lexically. Two files with the same numeric prefix (e.g.
  // 002-agents-table.sql + 002-messages-target-columns.sql) resolve by
  // the rest of the basename, which is stable and deterministic.
  entries.sort((a, b) => a.localeCompare(b));

  const rows = [];
  const claimed = new Set();
  const skipped = [];
  for (const basename of entries) {
    const contents = fs.readFileSync(path.join(MIGRATIONS_DIR, basename), 'utf-8');
    const finalTables = computeFinalTables(contents);
    const novelTables = finalTables.filter((t) => !claimed.has(t));
    if (novelTables.length === 0) {
      if (finalTables.length > 0) skipped.push(basename);
      continue;
    }
    for (const t of novelTables) claimed.add(t);
    rows.push({
      migrationFile: basename,
      expectedTables: novelTables.slice(0, MIGRATION_MAX_TABLES_PER_PROBE),
    });
  }
  return { rows, skipped };
}

function renderRegistry({ rows, skipped }) {
  const header = `/**
 * Migration schema probe registry.
 *
 * AUTO-GENERATED. Do NOT edit by hand — changes will be overwritten on
 * the next regen. Update by running:
 *
 *     npm run regen:migration-registry
 *
 * daemon/start.ts (via auto-registry.ts) instantiates one
 * MigrationSchemaProbeExperiment per row here. Each row names a SQL
 * migration file and the tables that migration should have created;
 * the probe periodically verifies those tables are still present.
 *
 * Regen rules (deterministic — see scripts/regen-migration-schema-registry.mjs):
 *   - Files enumerated in numerical order (lexical on the zero-padded prefix).
 *   - Tables parsed from CREATE/DROP/ALTER RENAME statements in each file.
 *   - First migration to CREATE a table wins; rename-in-place migrations
 *     yield no novel tables and are silently dropped.
 *   - Row emits only the novel tables for that migration, capped at
 *     ${MIGRATION_MAX_TABLES_PER_PROBE} per row.
 */

import type { MigrationSchemaProbeConfig } from '../experiments/migration-schema-probe.js';
`;

  const rowsLiteral = rows
    .map((r) => {
      const tablesLiteral = r.expectedTables.map((t) => `'${t}'`).join(', ');
      return `  { migrationFile: '${r.migrationFile}', expectedTables: [${tablesLiteral}] },`;
    })
    .join('\n');

  const skippedComment = skipped.length === 0
    ? ''
    : `\n// Migrations skipped (all tables claimed by an earlier migration —\n// e.g. rename-in-place or additive ALTER-only shapes):\n${skipped.map((s) => `//   - ${s}`).join('\n')}\n`;

  return `${header}
export const MIGRATION_SCHEMA_REGISTRY: readonly MigrationSchemaProbeConfig[] = [
${rowsLiteral}
];
${skippedComment}`;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const { rows, skipped } = buildRegistry();
  const rendered = renderRegistry({ rows, skipped });

  if (args.has('--print')) {
    process.stdout.write(rendered);
    return 0;
  }

  if (args.has('--check')) {
    let current = '';
    try {
      current = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    } catch (err) {
      process.stderr.write(`[regen:migration-registry] cannot read ${REGISTRY_PATH}: ${err.message}\n`);
      return 1;
    }
    if (current === rendered) {
      process.stdout.write(`[regen:migration-registry] ok — registry matches ${rows.length} migrations (skipped ${skipped.length}).\n`);
      return 0;
    }
    process.stderr.write(
      `[regen:migration-registry] STALE — registry drifts from src/db/migrations/. Run:\n` +
      `    npm run regen:migration-registry\n` +
      `and commit the result.\n`,
    );
    return 1;
  }

  fs.writeFileSync(REGISTRY_PATH, rendered, 'utf-8');
  process.stdout.write(
    `[regen:migration-registry] wrote ${rows.length} row(s) to ${path.relative(REPO_ROOT, REGISTRY_PATH)} (skipped ${skipped.length}).\n`,
  );
  return 0;
}

process.exit(main());
