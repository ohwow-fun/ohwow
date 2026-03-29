/**
 * Work Ontology — Public API
 *
 * The third philosophical layer: Brain (cognition) → Body (embodiment) → Work (purpose).
 * Seven Aristotelian modules for purpose-driven work.
 */

// Types
export type {
  WorkKind,
  TelosAlignment,
  TelosProfile,
  TelosInput,
  WorkImperative,
  ErgonClassification,
  ErgonInput,
  SuccessCriterion,
  KairosSignal,
  KairosUrgency,
  KairosGoal,
  PhronesisRecommendation,
  PriorityRule,
  DynamisProfile,
  DynamisInput,
  CapacityState,
  GrowthTrajectory,
  SynergeiaProfile,
  SynergeiaInput,
  CollaborationPattern,
  EudaimoniaScore,
  EudaimoniaInput,
  EudaimoniaDimension,
  EudaimoniaStatus,
  WorkOntologySnapshot,
} from './types.js';

// Telos (Purpose)
export { deriveTelos, assessTelosAlignment } from './telos.js';

// Ergon (Proper Function)
export { classifyWork, getEvaluationGuidance } from './ergon.js';

// Phronesis (Practical Wisdom)
export { getPhronesisRecommendation, scoreTaskPhronesis } from './phronesis.js';

// Kairos (Right Moment)
export { evaluateKairos } from './kairos.js';
export type { ProactiveSignalLike } from './kairos.js';

// Dynamis (Capacity)
export { computeDynamis, summarizeCapacity } from './dynamis.js';

// Synergeia (Collaboration)
export { computeSynergeia } from './synergeia.js';

// Eudaimonia (Flourishing)
export { computeEudaimonia, diagnoseEudaimonia } from './eudaimonia.js';
