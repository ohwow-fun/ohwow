/**
 * Eternal Systems — inactivity watcher.
 *
 * Computes how many days have elapsed since the last recorded operator
 * activity, then transitions the eternal mode if a protocol threshold is
 * crossed. Designed to be called at the start of each conductor tick so
 * mode transitions happen before any autonomous work proceeds.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { EternalMode, EternalSpec } from './types.js';
import { getEternalState, setEternalMode } from './state.js';
import { notifyTrustee } from './notifications.js';
import type { TrusteeNotifier } from './trustee-email.js';

const MS_PER_DAY = 86_400_000;

/**
 * Compute the mode that should be active given the elapsed days of
 * inactivity. Pure function — no side effects.
 */
export function modeForElapsedDays(
  elapsedDays: number,
  spec: EternalSpec,
): EternalMode {
  const { estateAfterDays, conservativeAfterDays } = spec.inactivityProtocol;
  if (elapsedDays >= estateAfterDays) return 'estate';
  if (elapsedDays >= conservativeAfterDays) return 'conservative';
  return 'normal';
}

/**
 * Check the current inactivity duration against the spec thresholds and,
 * if a transition is warranted, update the persisted mode.
 *
 * When `lastActivityAt` is null the system has never seen the operator —
 * treat as day 0 (normal mode) rather than triggering an immediate
 * transition on a fresh install.
 *
 * Returns the (possibly updated) mode after any transition.
 */
export async function checkAndMaybeUpdate(
  db: DatabaseAdapter,
  spec: EternalSpec,
  trusteeNotifier?: TrusteeNotifier,
): Promise<EternalMode> {
  const state = await getEternalState(db);

  if (!state.lastActivityAt) {
    // No activity recorded yet — system is freshly initialised; leave as normal.
    return state.mode;
  }

  const lastMs = Date.parse(state.lastActivityAt);
  if (Number.isNaN(lastMs)) {
    logger.warn(
      { lastActivityAt: state.lastActivityAt },
      'eternal.inactivity_watcher.invalid_timestamp',
    );
    return state.mode;
  }

  const elapsedDays = (Date.now() - lastMs) / MS_PER_DAY;
  const targetMode = modeForElapsedDays(elapsedDays, spec);

  if (targetMode === state.mode) {
    return state.mode;
  }

  const reason = `inactivity: ${elapsedDays.toFixed(1)} days since last activity`;
  logger.info(
    {
      previous_mode: state.mode,
      new_mode: targetMode,
      elapsed_days: elapsedDays.toFixed(1),
    },
    'eternal.mode_transition',
  );

  await setEternalMode(db, targetMode, reason);

  // Notify trustee whenever the mode moves to conservative or estate.
  if (targetMode === 'conservative' || targetMode === 'estate') {
    const notificationId = randomUUID();
    await notifyTrustee(db, targetMode, reason, notificationId);
    if (trusteeNotifier) {
      trusteeNotifier(db, notificationId, targetMode, reason).catch((err) =>
        logger.warn({ err }, 'eternal.trustee_notifier.failed'),
      );
    }
  }

  return targetMode;
}
