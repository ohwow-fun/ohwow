/**
 * Oneiros — Aristotle's De Somno + Jung's active imagination + DMN
 * Sleep consolidation, creative dreaming, and default mode background processing.
 */

export type SleepPhase = 'wake' | 'drowsy' | 'light_sleep' | 'deep_sleep' | 'REM' | 'waking';

export interface SleepState {
  phase: SleepPhase;
  sleepDebt: number;           // 0-1, accumulated need for consolidation
  lastConsolidation: number;   // epoch ms
  lastDream: number;           // epoch ms
  cycleCount: number;          // full sleep cycles completed
  enteredPhaseAt: number;      // epoch ms when current phase started
}

export interface ConsolidationResult {
  memoriesCompressed: number;
  memoriesPruned: number;
  memoriesStrengthened: number;
  insightsGenerated: string[];
}

export interface DreamAssociation {
  id: string;
  memoryA: { id: string; content: string; affect?: string };
  memoryB: { id: string; content: string; affect?: string };
  connection: string;          // the novel association discovered
  noveltyScore: number;        // 0-1
  promoted: boolean;           // true if broadcast to workspace
  timestamp: number;
}

export interface DefaultModeInsight {
  type: 'future_simulation' | 'spontaneous_insight' | 'creative_recombination';
  content: string;
  confidence: number;          // 0-1
  relatedMemoryIds: string[];
  timestamp: number;
}

export interface SleepDebtFactors {
  experiencesSinceLastSleep: number;
  hoursSinceLastConsolidation: number;
  memoryPressure: number;      // 0-1 from body state
}

/** Phase transition configuration */
export const PHASE_CONFIG = {
  /** Minutes of idle before entering drowsy */
  idleToDrowsy: 30,
  /** Minutes in drowsy before light sleep */
  drowsyToLight: 15,
  /** Minutes in light sleep before deep sleep */
  lightToDeep: 10,
  /** Minutes in deep sleep before REM */
  deepToREM: 20,
  /** Minutes in REM before cycling back to light */
  remToLight: 15,
  /** Maximum sleep cycles before forced wake */
  maxCycles: 3,
  /** Sleep debt threshold to trigger sleep (0-1) */
  sleepDebtThreshold: 0.6,
};
