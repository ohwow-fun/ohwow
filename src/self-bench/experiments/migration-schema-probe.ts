/**
 * MigrationSchemaProbeExperiment — parameterized probe that asserts
 * the tables created by a given SQL migration are still present in
 * the live SQLite schema.
 *
 * Why this exists
 * ---------------
 * Phase 7-D's autonomous author had been emitting one full TypeScript
 * file per migration via fillMigrationSchemaProbe — 17 byte-identical
 * classes whose only differences were the migration filename and the
 * expected-tables list. The audit in this commit reduced them to ~120
 * lines of parameterized class + a registry of `{ filename, tables }`
 * rows in src/self-bench/registries/migration-schema-registry.ts.
 *
 * Behavior is identical to the deleted per-migration classes:
 *   - hourly probe (everyMs: 1h, runOnBoot: false)
 *   - SELECT name FROM sqlite_master WHERE type='table'
 *   - Verdict=fail when any expected table is missing, pass otherwise
 *   - Subject = `migration:<filename>`, evidence carries the diff
 *
 * Identity
 * --------
 * Each registered instance gets a stable id of the form
 * `migration-schema:<slug-from-filename>`. The slug derivation matches
 * what the autonomous author emitted (e.g. '008-plans.sql' →
 * 'migration-schema:008-plans'), so historical findings keyed on the
 * old experiment ids are still queryable when this commit lands.
 *
 * Wait — that is NOT true. The deleted classes used ids like
 * `migration-schema-008-plans` (single hyphen, no colon). To preserve
 * ledger continuity, the new id MUST match. Implementation below uses
 * `migration-schema-${slug}` (no colon) accordingly.
 */

import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

const HOUR_MS = 60 * 60 * 1000;

interface MigrationSchemaEvidence extends Record<string, unknown> {
  migration_file: string;
  expected_tables: string[];
  present_count: number;
  missing_tables: string[];
}

interface SqliteMasterRow {
  name: string | null;
}

export interface MigrationSchemaProbeConfig {
  /** SQL migration filename, e.g. '119-runtime-config-overrides.sql'. */
  migrationFile: string;
  /** Tables the migration is expected to have created. */
  expectedTables: readonly string[];
}

export class MigrationSchemaProbeExperiment implements Experiment {
  readonly id: string;
  readonly name: string;
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis: string;
  readonly cadence = { everyMs: HOUR_MS, runOnBoot: false };

  private readonly migrationFile: string;
  private readonly expectedTables: readonly string[];

  constructor(config: MigrationSchemaProbeConfig) {
    this.migrationFile = config.migrationFile;
    this.expectedTables = config.expectedTables;
    this.id = `migration-schema-${slugFromFilename(config.migrationFile)}`;
    this.name = `Migration schema probe: ${config.migrationFile}`;
    this.hypothesis = `All tables created in ${config.migrationFile} remain present in the live sqlite schema.`;
  }

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { data } = await ctx.db
      .from<SqliteMasterRow>('sqlite_master')
      .select('name')
      .eq('type', 'table')
      .limit(1000);

    const rows = (data ?? []) as SqliteMasterRow[];
    const present = new Set<string>();
    for (const row of rows) {
      if (typeof row.name === 'string' && row.name.length > 0) {
        present.add(row.name);
      }
    }

    const missing = this.expectedTables.filter((t) => !present.has(t));

    const evidence: MigrationSchemaEvidence = {
      migration_file: this.migrationFile,
      expected_tables: [...this.expectedTables],
      present_count: present.size,
      missing_tables: missing,
    };

    const summary =
      missing.length === 0
        ? `${this.expectedTables.length} expected table(s) present for ${this.migrationFile}`
        : `${missing.length} missing table(s) for ${this.migrationFile}: ${missing.join(', ')}`;

    return {
      subject: `migration:${this.migrationFile}`,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as MigrationSchemaEvidence;
    return ev.missing_tables.length > 0 ? 'fail' : 'pass';
  }
}

/**
 * Derive an id-safe slug from a migration filename. Strips the .sql
 * extension. Example: '008-plans.sql' → '008-plans'. Matches the slug
 * the deleted per-migration classes baked into their ids so historical
 * findings stay queryable across the refactor.
 */
export function slugFromFilename(filename: string): string {
  return filename.replace(/\.sql$/i, '');
}
