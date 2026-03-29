/**
 * Daoist Wu Wei — sometimes the wisest action is inaction.
 * Buddhist Karuna — compassion for the biological being.
 */

// --- Energy Wave (Ultradian Rhythm) ---

export type EnergyWaveState = 'peak' | 'rising' | 'falling' | 'trough';

// --- Stress ---

export type StressLevel = 'calm' | 'focused' | 'pressured' | 'stressed';

// --- Composite Bio State ---

export interface BioState {
  energyWave: EnergyWaveState;
  stressLevel: StressLevel;
  recoveryNeeded: boolean;
  boundaryActive: boolean;
  notificationBudget: number;
}

// --- Work-Life Boundary ---

export interface WorkLifeBoundary {
  workStartHour: number;
  workEndHour: number;
  quietDays: number[];
  respectLevel: 'strict' | 'flexible' | 'none';
}

// --- Inputs ---

export interface EnergyWaveInput {
  activityTimestamps: number[];
  windowMinutes?: number;
}

export interface StressInput {
  recentMessageLengths: number[];
  recentApprovalSpeeds: number[];
  recentRejectionRate: number;
}

export interface RecoveryInput {
  consecutiveHighIntensityDays: number;
  currentWorkIntensity: string;
}

export interface NotificationFilterInput {
  bioState: BioState;
  pendingNotifications: number;
  criticalCount: number;
}

// --- Decisions ---

export interface NotificationDecision {
  action: 'send_all' | 'batch' | 'critical_only' | 'suppress';
  reason: string;
  delayMs?: number;
}
