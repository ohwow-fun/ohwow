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
 * class fed by MIGRATION_SCHEMA_REGISTRY. Same probe behavior, same
 * experiment ids (slugs preserved so historical findings stay
 * queryable). The factories below are generated from the registry at
 * module load — no manual maintenance for migration probes anymore.
 *
 * Until the proposal generator is updated to append to the registry
 * instead of writing new TS files (Layer 1 of the autonomous-fixing
 * safety floor — see the audit), the author may continue to author
 * per-migration files. Those files would land alongside the registry-
 * driven factories and emit duplicate findings. Track that risk in
 * ContentCadenceLoopHealthExperiment-style meta watchers as the
 * autonomous loop matures.
 */

import type { Experiment } from './experiment-types.js';
import { MigrationSchemaProbeExperiment } from './experiments/migration-schema-probe.js';
import { MIGRATION_SCHEMA_REGISTRY } from './registries/migration-schema-registry.js';
import { ToolchainToolTestStateExperiment } from './experiments/toolchain-tool-test-state.js';
import { ToolchainToolTestSynthesizeForGoalExperiment } from './experiments/toolchain-tool-test-synthesize-for-goal.js';
import { ToolchainToolTestWhatsappExperiment } from './experiments/toolchain-tool-test-whatsapp.js';
import { ToolchainToolTestAgentsExperiment } from './experiments/toolchain-tool-test-agents.js';
import { ToolchainToolTestCollectiveIntelligenceExperiment } from './experiments/toolchain-tool-test-collective-intelligence.js';
import { ToolchainToolTestHumanGrowthExperiment } from './experiments/toolchain-tool-test-human-growth.js';

/**
 * Array of zero-arg experiment factories. daemon/start.ts iterates this
 * and calls register(factory()) for each entry.
 */
import { ToolchainToolTestObservationExperiment } from './experiments/toolchain-tool-test-observation.js';
export const autoRegisteredExperiments: Array<() => Experiment> = [
  // Migration schema probes — one factory per registry row.
  ...MIGRATION_SCHEMA_REGISTRY.map(
    (config) => () => new MigrationSchemaProbeExperiment(config),
  ),
  // Toolchain test probes — pending the same registry-collapse refactor
  // as migration-schema. For now these stay as individual factories.
  () => new ToolchainToolTestStateExperiment(),
  () => new ToolchainToolTestSynthesizeForGoalExperiment(),
  () => new ToolchainToolTestWhatsappExperiment(),
  () => new ToolchainToolTestAgentsExperiment(),
  () => new ToolchainToolTestCollectiveIntelligenceExperiment(),
  () => new ToolchainToolTestHumanGrowthExperiment(),
  () => new ToolchainToolTestObservationExperiment(),
];
