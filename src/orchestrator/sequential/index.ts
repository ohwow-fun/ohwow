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
