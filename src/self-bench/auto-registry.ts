/**
 * auto-registry.ts — AUTO-MAINTAINED by ExperimentAuthorExperiment.
 *
 * Every experiment committed autonomously via Phase 7-D is listed here
 * as a factory function. daemon/start.ts imports this file and registers
 * all entries with the experiment runner at startup.
 *
 * ExperimentAuthorExperiment appends one line to this array after every
 * successful safeSelfCommit. Do not edit manually — changes will be
 * overwritten by the next autonomous authoring cycle.
 *
 * Safety notes
 * ------------
 * - safeSelfCommit's ALLOWED_PATH_PREFIXES includes this file so the
 *   author can update it after each new experiment commit.
 * - The author only ever appends to the factories array; it never removes
 *   or reorders lines. Deletions are a human operation.
 * - Each entry is a zero-arg factory (() => Experiment) so daemon/start.ts
 *   can construct experiments after importing without coupling to class
 *   names at the import site.
 *
 * Slop-refactor note (2026-04-14)
 * --------------------------------
 * The 19 individual MigrationSchema*Experiment files this file used to
 * import were collapsed into a single MigrationSchemaProbeExperiment
 * class fed by MIGRATION_SCHEMA_REGISTRY. The 9 individual
 * ToolchainToolTest*Experiment files were collapsed into a single
 * ToolchainTestProbeExperiment class fed by TOOLCHAIN_TEST_REGISTRY.
 * Same probe behavior, same evidence shapes, same ids preserved
 * (so historical findings stay queryable). The factories below are
 * generated from the registries at module load.
 *
 * Until the proposal generator is updated to append to the registries
 * instead of writing new TS files (Layer 1 of the autonomous-fixing
 * safety floor — see the audit), the author may continue to author
 * per-{migration,tool} files. Those files would land alongside the
 * registry-driven factories and emit duplicate findings. Track that
 * risk in ContentCadenceLoopHealthExperiment-style meta watchers as
 * the autonomous loop matures.
 */

import type { Experiment } from './experiment-types.js';
import { MigrationSchemaProbeExperiment } from './experiments/migration-schema-probe.js';
import { MIGRATION_SCHEMA_REGISTRY } from './registries/migration-schema-registry.js';
import { ToolchainTestProbeExperiment } from './experiments/toolchain-test-probe.js';
import { TOOLCHAIN_TEST_REGISTRY } from './registries/toolchain-test-registry.js';
import { ScrapeDiffProbeExperiment } from './experiments/scrape-diff-probe.js';
import { SCRAPE_DIFF_REGISTRY } from './registries/scrape-diff-registry.js';

/**
 * Array of zero-arg experiment factories. daemon/start.ts iterates this
 * and calls register(factory()) for each entry.
 */
export const autoRegisteredExperiments: Array<() => Experiment> = [
  // Migration schema probes — one factory per registry row.
  ...MIGRATION_SCHEMA_REGISTRY.map(
    (config) => () => new MigrationSchemaProbeExperiment(config),
  ),
  // Toolchain test probes — one factory per registry row.
  ...TOOLCHAIN_TEST_REGISTRY.map(
    (config) => () => new ToolchainTestProbeExperiment(config),
  ),
  // Market-radar scrape-diff probes — one factory per registry row.
  ...SCRAPE_DIFF_REGISTRY.map(
    (config) => () => new ScrapeDiffProbeExperiment(config),
  ),
];
