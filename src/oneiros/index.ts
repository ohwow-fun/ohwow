export type {
  SleepPhase,
  SleepState,
  ConsolidationResult,
  DreamAssociation,
  DefaultModeInsight,
  SleepDebtFactors,
} from './types.js';
export { PHASE_CONFIG } from './types.js';

export { SleepCycle } from './sleep-cycle.js';

export {
  selectForConsolidation,
  identifyForPruning,
  identifyForStrengthening,
} from './consolidation.js';
export type { ConsolidationMemory } from './consolidation.js';

export { generateDreamAssociations } from './dreaming.js';
export type { DreamMemory } from './dreaming.js';

export {
  generateSpontaneousInsight,
  simulateFuture,
} from './default-mode.js';
export type { DMNPattern, DMNPrinciple, DMNGoal } from './default-mode.js';
