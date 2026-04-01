export { HabitEngine } from './habit-engine.js';
export { detectCues } from './cue-detector.js';
export { computeStrength, computeAutomaticity, decayHabitStrength } from './habit-strength.js';
export { detectBadHabits } from './bad-habit-detector.js';
export type {
  Habit,
  HabitCue,
  HabitRoutine,
  HabitReward,
  HabitMatch,
  HabitPhase,
  AutomaticityLevel,
  BadHabitIndicator,
} from './types.js';
export { AUTOMATICITY_THRESHOLDS, DEFAULT_DECAY_RATE } from './types.js';
