export type {
  MetricName,
  SetPoint,
  CorrectiveAction,
  CorrectiveActionType,
  HomeostasisState,
  AllostasisEvent,
} from './types.js';

export { DEFAULT_SET_POINTS } from './types.js';
export { initializeSetPoints, updateSetPoint, adaptSetPoint } from './set-points.js';
export { computeCorrectiveAction, computeAllCorrectiveActions } from './feedback-loops.js';
export { HomeostasisController } from './homeostasis-controller.js';
