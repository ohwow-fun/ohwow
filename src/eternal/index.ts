/**
 * Eternal Systems — public API.
 *
 * Re-exports the types, defaults, state helpers, inactivity watcher,
 * and values corpus reader. Import from this barrel when wiring the
 * eternal module into conductors, API routes, or CLI commands.
 */
export type {
  EternalMode,
  EternalSpec,
  EternalState,
  EscalationRule,
  InactivityProtocol,
} from './types.js';

export { DEFAULT_ETERNAL_SPEC } from './defaults.js';

export {
  getEternalState,
  setEternalMode,
  recordActivity,
} from './state.js';

export {
  modeForElapsedDays,
  checkAndMaybeUpdate,
} from './inactivity-watcher.js';

export { readValuesCorpus } from './values-reader.js';

export {
  modeToDecisionType,
  requiresTrusteeApproval,
} from './escalation.js';
