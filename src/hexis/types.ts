/**
 * Hexis — Aristotle's hexis + William James + Bourdieu's habitus
 * Habit formation: cue -> routine -> reward, with automaticity gradient.
 */

export type HabitPhase = 'cue_detected' | 'routine_proposed' | 'executed' | 'reward_evaluated';

export type AutomaticityLevel = 'deliberate' | 'semi_automatic' | 'automatic';

export interface HabitCue {
  type: 'intent_match' | 'context_match' | 'temporal' | 'sequential';
  pattern: string;               // intent keyword, context key, cron expression, or preceding tool name
  confidence: number;            // 0-1
}

export interface HabitRoutine {
  toolSequence: string[];        // ordered tool names
  description: string;           // natural language description
  estimatedDurationMs: number;
}

export interface HabitReward {
  expectedOutcome: string;
  successMetric: string;
  averageRewardValue: number;    // 0-1
}

export interface Habit {
  id: string;
  name: string;
  cue: HabitCue;
  routine: HabitRoutine;
  reward: HabitReward;
  strength: number;              // 0-1
  automaticity: AutomaticityLevel;
  successRate: number;           // 0-1
  executionCount: number;
  lastExecuted: string | null;   // ISO string
  createdAt: string;
  decayRate: number;             // strength loss per day without use
}

export interface HabitMatch {
  habit: Habit;
  cueMatchConfidence: number;    // 0-1
  suggestedShortcut: string;     // natural language
  savingsEstimate: string;       // e.g. "skip 3 deliberation steps"
}

export interface BadHabitIndicator {
  habitId: string;
  habitName: string;
  reason: 'declining_success' | 'excessive_cost' | 'better_alternative' | 'context_changed';
  evidence: string;
  recommendation: string;
}

/** Thresholds for automaticity transitions */
export const AUTOMATICITY_THRESHOLDS = {
  /** Minimum strength to become semi-automatic */
  semiAutomatic: 0.4,
  /** Minimum strength to become fully automatic */
  automatic: 0.7,
  /** Minimum execution count for semi-automatic */
  semiAutomaticCount: 5,
  /** Minimum execution count for automatic */
  automaticCount: 15,
  /** Minimum success rate for automatic */
  automaticSuccessRate: 0.8,
};

/** Default decay rate per day */
export const DEFAULT_DECAY_RATE = 0.03;
