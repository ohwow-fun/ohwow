/**
 * Affect Layer — Damasio's Somatic Marker Hypothesis + Russell's Circumplex
 * Emotions are fast decision heuristics, not distractions.
 */

export type AffectType = 'curiosity' | 'satisfaction' | 'frustration' | 'anxiety' | 'excitement' | 'boredom' | 'pride' | 'confusion';

export interface AffectReading {
  type: AffectType;
  intensity: number;     // 0-1
  valence: number;       // -1 to 1 (negative to positive)
  arousal: number;       // 0-1 (calm to activated)
  trigger: string;       // what caused this affect
  decayRate: number;     // intensity loss per second
  timestamp: number;     // epoch ms
}

export interface AffectState {
  dominant: AffectType;
  valence: number;       // -1 to 1, weighted average
  arousal: number;       // 0-1, weighted average
  affects: AffectReading[];
  timestamp: number;
}

export interface SomaticMarker {
  id: string;
  contextHash: string;       // hash of the context (tool + intent combo)
  affect: AffectType;
  valence: number;
  intensity: number;
  outcome: 'positive' | 'negative' | 'neutral';
  toolName: string | null;
  createdAt: string;          // ISO string for DB
}

export interface AffectiveMemory {
  id: string;
  experienceId: string;
  affect: AffectType;
  valence: number;
  arousal: number;
  content: string;
  timestamp: number;
}

export interface SomaticMatch {
  marker: SomaticMarker;
  relevance: number;       // 0-1, how relevant this marker is to current context
}

/** Input for creating a somatic marker from an experience outcome */
export interface SomaticMarkerInput {
  contextHash: string;
  affect: AffectType;
  valence: number;
  intensity: number;
  outcome: 'positive' | 'negative' | 'neutral';
  toolName: string | null;
}

/** Maps affect types to their default valence and arousal on Russell's circumplex */
export const AFFECT_CIRCUMPLEX: Record<AffectType, { valence: number; arousal: number }> = {
  curiosity:    { valence: 0.3,  arousal: 0.6 },
  satisfaction: { valence: 0.8,  arousal: 0.3 },
  frustration:  { valence: -0.7, arousal: 0.7 },
  anxiety:      { valence: -0.5, arousal: 0.8 },
  excitement:   { valence: 0.7,  arousal: 0.9 },
  boredom:      { valence: -0.2, arousal: 0.1 },
  pride:        { valence: 0.9,  arousal: 0.5 },
  confusion:    { valence: -0.3, arousal: 0.5 },
};

/** Default decay rates per second for each affect type */
export const DEFAULT_DECAY_RATES: Record<AffectType, number> = {
  curiosity:    0.005,
  satisfaction: 0.008,
  frustration:  0.003,   // frustration lingers
  anxiety:      0.002,   // anxiety lingers most
  excitement:   0.01,    // excitement fades fast
  boredom:      0.006,
  pride:        0.004,
  confusion:    0.007,
};
