/**
 * MigrationDriftSentinelExperiment — Layer 6 of the bench level-up plan.
 *
 * A single rolling summary of the migration-schema registry's live
 * health. Runs every 30 minutes and writes ONE finding per tick
 * covering all 70+ registry rows at once. The per-migration
 * MigrationSchemaProbeExperiment instances still exist for their
 * historical ledger continuity + deep evidence, but their cadence was
 * raised from 1 h to 6 h in the same commit — the sentinel is the
 * hot-path awareness signal and the per-migration probes are the
 * every-few-hours confirmation.
 *
 * The finding carries a compact evidence shape:
 *   registered_count: total rows in MIGRATION_SCHEMA_REGISTRY
 *   all_passing:     boolean — every registered table currently exists
 *   missing_rows:    only rows with missing tables, each expanded
 *                    { migration_file, missing_tables[] }
 *
 * Verdict: pass when all_passing, fail when any row has missing tables
 * (drift is always fail-worthy). This is the right level to feed into
 * RoadmapObserver, strategist, or a human dashboard — without it, the
 * ledger had to aggregate 70+ pass rows to notice "one broke".
 */

import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { MIGRATION_SCHEMA_REGISTRY } from '../registries/migration-schema-registry.js';

interface SqliteMasterRow {
  name: string | null;
}

export interface MigrationDriftEvidence extends Record<string, unknown> {
  registered_count: number;
  all_passing: boolean;
  missing_rows: Array<{ migration_file: string; missing_tables: string[] }>;
  live_table_count: number;
}

export class MigrationDriftSentinelExperiment implements Experiment {
  readonly id = 'migration-drift-sentinel';
  readonly name = 'Migration drift sentinel (Layer 6)';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    `The ${MIGRATION_SCHEMA_REGISTRY.length}-row migration registry has a deterministic expected-tables set. A single rolling probe can summarise all of it at once, replacing 70+ per-migration pass findings with one status row and still flagging drift the moment it happens.`;
  readonly cadence = { everyMs: 30 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { data } = await ctx.db
      .from<SqliteMasterRow>('sqlite_master')
      .select('name')
      .eq('type', 'table')
      .limit(2000);

    const rows = (data ?? []) as SqliteMasterRow[];
    const present = new Set<string>();
    for (const row of rows) {
      if (typeof row.name === 'string' && row.name.length > 0) {
        present.add(row.name);
      }
    }

    const missingRows: Array<{ migration_file: string; missing_tables: string[] }> = [];
    for (const row of MIGRATION_SCHEMA_REGISTRY) {
      const missing = row.expectedTables.filter((t) => !present.has(t));
      if (missing.length > 0) {
        missingRows.push({ migration_file: row.migrationFile, missing_tables: missing });
      }
    }

    const evidence: MigrationDriftEvidence = {
      registered_count: MIGRATION_SCHEMA_REGISTRY.length,
      all_passing: missingRows.length === 0,
      missing_rows: missingRows,
      live_table_count: present.size,
    };

    const summary = missingRows.length === 0
      ? `all ${MIGRATION_SCHEMA_REGISTRY.length} migrations have expected tables present (${present.size} live)`
      : `${missingRows.length}/${MIGRATION_SCHEMA_REGISTRY.length} migrations missing tables: ${missingRows.slice(0, 3).map((r) => r.migration_file).join(', ')}${missingRows.length > 3 ? ', …' : ''}`;

    return { subject: 'migration:drift', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as MigrationDriftEvidence;
    return ev.all_passing ? 'pass' : 'fail';
  }
}
