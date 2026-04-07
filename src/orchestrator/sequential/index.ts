/**
 * Sequential Multi-Agent Coordination (Local Runtime)
 */

export type {
  SequenceStep,
  SequenceDefinition,
  SequenceStepResult,
  SequenceStepStatus,
  SequenceResult,
  SequenceEvent,
} from './types.js';

export { topologicalSort } from './topological-sort.js';
export type { Sortable } from './topological-sort.js';

export { buildPredecessorContext, estimatePredecessorTokens } from './predecessor-context.js';
export type { PredecessorContextOptions } from './predecessor-context.js';

export { executeSequence } from './sequential-executor.js';
export type { ExecuteSequenceOptions } from './sequential-executor.js';

export { shouldSequence } from './should-sequence.js';
export type { ShouldSequenceInput, ShouldSequenceResult } from './should-sequence.js';

export { decomposeIntoSequence } from './sequence-decomposer.js';
export type { DecomposeInput } from './sequence-decomposer.js';

export { checkAbstention } from './abstention-check.js';
export type { AbstentionDecision, AbstentionCheckInput } from './abstention-check.js';

export { createEphemeralAgent } from './agent-factory.js';
export type { AgentGenesisInput, AgentGenesisResult } from './agent-factory.js';

export { checkPromotion, checkSequencePromotions } from './promotion-engine.js';
export type { PromotionCheckResult } from './promotion-engine.js';

export { executeStepOnCloud } from './cross-env-executor.js';
export type { CrossEnvStepInput } from './cross-env-executor.js';

export { estimateSequenceCost, checkSequenceBudget } from './cost-estimator.js';
export type { StepCostEstimate, SequenceCostEstimate } from './cost-estimator.js';
