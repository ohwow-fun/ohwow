/**
 * CDP lane lock — per-workspace FIFO mutex around browser operations that
 * share the debug Chrome surface.
 *
 * Why this exists
 * ---------------
 * Multiple schedulers (XDmPollerScheduler, ContentCadenceScheduler,
 * agent-driven x-posting calls) all attach to the same RawCdpBrowser on
 * :9222 via chrome-profile-router. Each scheduler's own `executing`
 * boolean only prevents overlap within its own instance — there is no
 * cross-scheduler coordination. A DM poller tick that navigates between
 * thread tabs can collide with a content-cadence post on a different
 * tab but the same Chrome.
 *
 * Acquisition semantics
 * ---------------------
 * - FIFO per workspaceId. Separate workspaces never contend.
 * - `withCdpLane` awaits acquisition, runs the callback, and releases
 *   the lock in a finally block — a throw still wakes the next waiter.
 * - Default deadline of 3 minutes. A waiter that exceeds it rejects
 *   with a `CdpLaneDeadlineError` and is removed from the queue so
 *   subsequent releases continue draining.
 * - Re-entrant on the same workspaceId: if the caller is already
 *   inside a lane (tracked via AsyncLocalStorage), the callback runs
 *   synchronously without re-acquiring. Avoids self-deadlock when a
 *   locked op calls into another helper that also locks.
 * - Optional AbortSignal cancels a pending wait and removes the
 *   waiter from the queue.
 *
 * Scope
 * -----
 * In-process only. Child-process schedulers (x-intel, x-humor) spawn
 * external Node processes for their browser work and cannot share this
 * lock; their CDP usage is currently advisory and outside the lane.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from '../../lib/logger.js';

const DEFAULT_DEADLINE_MS = 3 * 60 * 1000;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  label: string;
  enqueuedAt: number;
}

interface Lane {
  held: boolean;
  queue: Waiter[];
}

const lanes = new Map<string, Lane>();
const als = new AsyncLocalStorage<{ workspaceId: string }>();

export class CdpLaneDeadlineError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly label: string,
    public readonly waitedMs: number,
  ) {
    super(
      `cdp-lane: waiter '${label}' for workspace '${workspaceId}' expired after ${waitedMs}ms`,
    );
    this.name = 'CdpLaneDeadlineError';
  }
}

export class CdpLaneAbortedError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly label: string,
  ) {
    super(
      `cdp-lane: waiter '${label}' for workspace '${workspaceId}' aborted before acquire`,
    );
    this.name = 'CdpLaneAbortedError';
  }
}

export interface WithCdpLaneOptions {
  /** Human-readable tag used in deadline errors and debug logs. */
  label?: string;
  /** Max time a waiter blocks before rejecting. Default 3 minutes. */
  deadlineMs?: number;
  /** Cancels a pending acquire. Ignored once the lock is held. */
  signal?: AbortSignal;
}

/**
 * Run `fn` while holding the workspace's CDP lane.
 *
 * Re-entrant on the same workspaceId: a call made from inside another
 * `withCdpLane` for the SAME workspace runs the callback immediately
 * without re-acquiring. Nested calls against a DIFFERENT workspaceId
 * are rare but legal — they acquire the other workspace's lane
 * independently.
 */
export async function withCdpLane<T>(
  workspaceId: string,
  fn: () => Promise<T>,
  opts: WithCdpLaneOptions = {},
): Promise<T> {
  const current = als.getStore();
  if (current?.workspaceId === workspaceId) {
    return fn();
  }
  const label = opts.label ?? 'unlabeled';
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  await acquire(workspaceId, label, deadlineMs, opts.signal);
  try {
    return await als.run({ workspaceId }, fn);
  } finally {
    release(workspaceId);
  }
}

function getLane(workspaceId: string): Lane {
  let lane = lanes.get(workspaceId);
  if (!lane) {
    lane = { held: false, queue: [] };
    lanes.set(workspaceId, lane);
  }
  return lane;
}

function acquire(
  workspaceId: string,
  label: string,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new CdpLaneAbortedError(workspaceId, label));
  }
  const lane = getLane(workspaceId);
  if (!lane.held) {
    lane.held = true;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const enqueuedAt = Date.now();
    const timer = setTimeout(() => {
      removeWaiter(lane, waiter);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new CdpLaneDeadlineError(workspaceId, label, Date.now() - enqueuedAt));
    }, deadlineMs);
    const waiter: Waiter = { resolve, reject, timer, label, enqueuedAt };
    const onAbort = () => {
      removeWaiter(lane, waiter);
      clearTimeout(timer);
      reject(new CdpLaneAbortedError(workspaceId, label));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    lane.queue.push(waiter);
    logger.debug(
      { workspaceId, label, queueDepth: lane.queue.length },
      '[cdp-lane] waiting',
    );
  });
}

function removeWaiter(lane: Lane, waiter: Waiter): void {
  const idx = lane.queue.indexOf(waiter);
  if (idx >= 0) lane.queue.splice(idx, 1);
}

function release(workspaceId: string): void {
  const lane = lanes.get(workspaceId);
  if (!lane) return;
  const next = lane.queue.shift();
  if (next) {
    clearTimeout(next.timer);
    logger.debug(
      { workspaceId, label: next.label, waitedMs: Date.now() - next.enqueuedAt },
      '[cdp-lane] granting to next waiter',
    );
    next.resolve();
  } else {
    lane.held = false;
  }
}

/** Test-only: reset all lane state. Do not call from production code. */
export function _resetCdpLanesForTests(): void {
  for (const lane of lanes.values()) {
    for (const waiter of lane.queue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('cdp-lane: reset during test'));
    }
    lane.queue.length = 0;
    lane.held = false;
  }
  lanes.clear();
}

/** Test-only: snapshot of a lane's current state. */
export function _inspectCdpLaneForTests(workspaceId: string): {
  held: boolean;
  queueDepth: number;
} {
  const lane = lanes.get(workspaceId);
  if (!lane) return { held: false, queueDepth: 0 };
  return { held: lane.held, queueDepth: lane.queue.length };
}
