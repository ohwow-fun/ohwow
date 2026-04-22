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
  TrusteeContact,
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

export { loadEternalSpec, saveEternalSpec } from './load-spec.js';

export {
  modeToDecisionType,
  requiresTrusteeApproval,
} from './escalation.js';

export { notifyTrustee } from './notifications.js';

export { createTrusteeNotifier, resolveTrusteeNotifier } from './trustee-email.js';
export type { TrusteeNotifier } from './trustee-email.js';
