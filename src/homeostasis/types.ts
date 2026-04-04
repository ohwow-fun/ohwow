/**
 * Homeostasis — Cannon's homeostasis + Ashby's ultrastability + allostasis
 * Active self-regulation through negative feedback loops.
 */

export type MetricName =
  | 'memory_count'
  | 'cost_per_day'
  | 'success_rate'
  | 'utilization'
  | 'error_rate'
  | 'sleep_debt'
  | 'synapse_health';

export interface SetPoint {
  metric: MetricName;
  target: number;
  tolerance: number;        // acceptable deviation as fraction of target (0-1)
  current: number;
  errorSignal: number;      // current - target (signed)
  deviationMagnitude: number; // |errorSignal| / target, normalized 0-1
  adaptationRate: number;   // how fast set point itself shifts (0-1)
}

export type CorrectiveActionType = 'throttle' | 'compress_memory' | 'adjust_routing' | 'alert_human' | 'none';

export interface CorrectiveAction {
  type: CorrectiveActionType;
  metric: MetricName;
  reason: string;
  urgency: number;          // 0-1
}

export interface HomeostasisState {
  setPoints: SetPoint[];
  overallDeviation: number;  // 0-1, aggregate error magnitude
  correctiveActions: CorrectiveAction[];
  lastChecked: number;
}

export interface AllostasisEvent {
  metric: MetricName;
  oldTarget: number;
  newTarget: number;
  reason: string;
  timestamp: string;
}

/** Default set point targets by metric */
export const DEFAULT_SET_POINTS: Record<MetricName, { target: number; tolerance: number; adaptationRate: number }> = {
  memory_count:   { target: 500,  tolerance: 0.4,  adaptationRate: 0.05 },
  cost_per_day:   { target: 50,   tolerance: 0.3,  adaptationRate: 0.1 },
  success_rate:   { target: 0.8,  tolerance: 0.15, adaptationRate: 0.05 },
  utilization:    { target: 0.6,  tolerance: 0.25, adaptationRate: 0.1 },
  error_rate:     { target: 0.05, tolerance: 0.5,  adaptationRate: 0.05 },
  sleep_debt:     { target: 0.2,  tolerance: 0.3,  adaptationRate: 0.02 },
  synapse_health: { target: 0.7,  tolerance: 0.2,  adaptationRate: 0.05 },
};
