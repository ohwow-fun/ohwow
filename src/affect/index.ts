export type {
  AffectType,
  AffectReading,
  AffectState,
  SomaticMarker,
  AffectiveMemory,
  SomaticMatch,
  SomaticMarkerInput,
} from './types.js';

export { AFFECT_CIRCUMPLEX, DEFAULT_DECAY_RATES } from './types.js';
export { decayAffects, computeAffectState } from './affect-decay.js';
export { matchSomaticMarkers, createContextHash, summarizeSomaticWarnings } from './somatic-markers.js';
export { AffectEngine } from './affect-engine.js';
