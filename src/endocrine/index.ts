export type {
  HormoneType,
  HormoneLevel,
  HormoneProfile,
  EndocrineTone,
  HormoneEffect,
  HormoneStimulus,
  CascadeRule,
} from './types.js';

export { DEFAULT_BASELINES, DEFAULT_CASCADE_RULES } from './types.js';
export { computeCascade } from './hormone-cascade.js';
export { computeEffects, summarizeEffects } from './cross-layer-effects.js';
export { EndocrineSystem } from './endocrine-system.js';
