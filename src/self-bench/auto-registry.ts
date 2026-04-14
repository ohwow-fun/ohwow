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
 */

import type { Experiment } from './experiment-types.js';
import { MigrationSchema010LocalCrmExperiment } from './experiments/migration-schema-010-local-crm.js';
import { MigrationSchema012OrchestratorMemoryExperiment } from './experiments/migration-schema-012-orchestrator-memory.js';
import { MigrationSchema014WebhooksAndTriggersExperiment } from './experiments/migration-schema-014-webhooks-and-triggers.js';
import { MigrationSchema015FileAttachmentsExperiment } from './experiments/migration-schema-015-file-attachments.js';
import { MigrationSchema016DashboardTablesExperiment } from './experiments/migration-schema-016-dashboard-tables.js';
import { MigrationSchema017WorkflowTriggersExperiment } from './experiments/migration-schema-017-workflow-triggers.js';
import { MigrationSchema018WorkspaceOnboardingExperiment } from './experiments/migration-schema-018-workspace-onboarding.js';
import { MigrationSchema023LocalFileAccessExperiment } from './experiments/migration-schema-023-local-file-access.js';
import { MigrationSchema024ModelStatsExperiment } from './experiments/migration-schema-024-model-stats.js';
import { MigrationSchema062EndocrineSystemExperiment } from './experiments/migration-schema-062-endocrine-system.js';
import { MigrationSchema072BiologicalOrgExperiment } from './experiments/migration-schema-072-biological-org.js';
import { MigrationSchema103FixPersonModelsFkExperiment } from './experiments/migration-schema-103-fix-person-models-fk.js';
import { MigrationSchema104FixPersonObservationsFkExperiment } from './experiments/migration-schema-104-fix-person-observations-fk.js';
import { MigrationSchema105OnboardingPlansExperiment } from './experiments/migration-schema-105-onboarding-plans.js';
import { MigrationSchema116SelfFindingsExperiment } from './experiments/migration-schema-116-self-findings.js';
import { MigrationSchema117ExperimentValidationsExperiment } from './experiments/migration-schema-117-experiment-validations.js';
import { MigrationSchema119RuntimeConfigOverridesExperiment } from './experiments/migration-schema-119-runtime-config-overrides.js';

/**
 * Array of zero-arg experiment factories. daemon/start.ts iterates this
 * and calls register(factory()) for each entry.
 *
 * ExperimentAuthorExperiment appends new entries here after each commit.
 * Entries are append-only — removal is manual.
 */
import { ToolchainToolTestStateExperiment } from './experiments/toolchain-tool-test-state.js';
import { ToolchainToolTestSynthesizeForGoalExperiment } from './experiments/toolchain-tool-test-synthesize-for-goal.js';
import { ToolchainToolTestWhatsappExperiment } from './experiments/toolchain-tool-test-whatsapp.js';
import { MigrationSchema009NudgesExperiment } from './experiments/migration-schema-009-nudges.js';
import { ToolchainToolTestAgentsExperiment } from './experiments/toolchain-tool-test-agents.js';
export const autoRegisteredExperiments: Array<() => Experiment> = [
  () => new MigrationSchema010LocalCrmExperiment(),
  () => new MigrationSchema012OrchestratorMemoryExperiment(),
  () => new MigrationSchema014WebhooksAndTriggersExperiment(),
  () => new MigrationSchema015FileAttachmentsExperiment(),
  () => new MigrationSchema016DashboardTablesExperiment(),
  () => new MigrationSchema017WorkflowTriggersExperiment(),
  () => new MigrationSchema018WorkspaceOnboardingExperiment(),
  () => new MigrationSchema023LocalFileAccessExperiment(),
  () => new MigrationSchema024ModelStatsExperiment(),
  () => new MigrationSchema062EndocrineSystemExperiment(),
  () => new MigrationSchema072BiologicalOrgExperiment(),
  () => new MigrationSchema103FixPersonModelsFkExperiment(),
  () => new MigrationSchema104FixPersonObservationsFkExperiment(),
  () => new MigrationSchema105OnboardingPlansExperiment(),
  () => new MigrationSchema116SelfFindingsExperiment(),
  () => new MigrationSchema117ExperimentValidationsExperiment(),
  () => new MigrationSchema119RuntimeConfigOverridesExperiment(),
  () => new ToolchainToolTestStateExperiment(),
  () => new ToolchainToolTestSynthesizeForGoalExperiment(),
  () => new ToolchainToolTestWhatsappExperiment(),
  () => new MigrationSchema009NudgesExperiment(),
  () => new ToolchainToolTestAgentsExperiment(),
];
