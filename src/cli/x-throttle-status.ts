/* eslint-disable no-console */
/**
 * `ohwow x-throttle-status` — human-readable readout of the X search
 * authenticated-RPC throttle state.
 *
 * Pulls from ~/.ohwow/x-search-throttle.json (the shared state file owned
 * by src/lib/x-search-throttle.ts) so operators staring at a stuck
 * scheduler can answer "is X throttled right now, and if so, for how
 * long?" in one command.
 *
 * Usage:
 *   ohwow x-throttle-status           Pretty text readout
 *   ohwow x-throttle-status --json    Machine-readable state (for scripts)
 */

import {
  STATE_FILE_PATH,
  isThrottled,
  readThrottleState,
  type ThrottleState,
} from '../lib/x-search-throttle.js';
import { formatDuration } from '../lib/format-duration.js';

export function runXThrottleStatusCli(args: string[]): void {
  const asJson = args.includes('--json');
  const state = readThrottleState();
  const status = isThrottled();

  if (asJson) {
    const payload = {
      state_file: STATE_FILE_PATH,
      throttled: status.throttled,
      until: status.until?.toISOString() ?? null,
      remaining_ms: status.remainingMs,
      consecutive_hits: state.consecutive_hits,
      last_hit_at: state.last_hit_at,
      last_hit_url: state.last_hit_url ?? null,
      last_recovery_at: state.last_recovery_at ?? null,
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  renderPretty(state, status);
}

function renderPretty(
  state: ThrottleState,
  status: { throttled: boolean; until: Date | null; remainingMs: number },
): void {
  console.log('');
  console.log(`X search throttle`);
  console.log(`  state file:        ${STATE_FILE_PATH}`);

  if (!status.throttled) {
    console.log(`  status:            ok (not throttled)`);
  } else if (status.until) {
    console.log(`  status:            throttled`);
    console.log(`  clears in:         ${formatDuration(status.remainingMs)}`);
    console.log(`  clears at:         ${status.until.toISOString()}`);
  }

  console.log(`  consecutive hits:  ${state.consecutive_hits}`);

  if (state.last_hit_at) {
    console.log(`  last hit at:       ${state.last_hit_at}`);
  } else {
    console.log(`  last hit at:       never`);
  }

  if (state.last_hit_url) {
    console.log(`  last hit url:      ${state.last_hit_url}`);
  }

  if (state.last_recovery_at) {
    console.log(`  last recovery at:  ${state.last_recovery_at}`);
  }

  console.log('');
  console.log(
    `To clear the throttle manually: rm "${STATE_FILE_PATH}"  (useful for testing only — the real window matters)`,
  );
  console.log('');
}
