export type {
  PathogenType,
  AlertLevel,
  ThreatSignature,
  ThreatDetection,
  ImmuneMemory,
  InflammatoryState,
  AutoimmuneIndicator,
} from './types.js';

export { INNATE_SIGNATURES } from './types.js';
export { scanInnate } from './innate-immunity.js';
export { matchImmuneMemory, learnThreat, computeResponseEffectiveness } from './adaptive-immunity.js';
export { computeAlertLevel, shouldEscalate, computeCooldown, tryDeescalate, createInitialInflammatoryState } from './inflammatory-response.js';
export { assessSelfNonSelf, detectAutoimmune } from './tolerance.js';
export { ImmuneSystem } from './immune-system.js';
