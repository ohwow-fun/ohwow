/**
 * x-search-throttle.ts — cross-process throttle state for authenticated
 * x.com search scraping.
 *
 * Calibration notes (2026-04-18 session):
 *   - Authenticated /search?q=... RPC trips a throttle on burst sweeps.
 *     When tripped, the timeline renders the "Something went wrong. Try
 *     reloading." error shell with zero articles. Home / explore stay
 *     fine during the window.
 *   - Safe inter-query floor is ~60-90s. Burst sweeps trip a 15-60 min
 *     cooldown.
 *
 * This module is the PERSISTENT layer. In-flight detection
 * (`XSearchRateLimitedError` from scripts/x-experiments/_x-harvest.mjs
 * OR the local detectors in x-reply.ts / threads-reply.ts) throws a
 * RateLimited error; the caller catches it and calls `markThrottled`
 * here. On the next scheduler tick, `assertNotThrottled` short-circuits
 * the scraper before it touches the browser, so a throttled account
 * never re-hits the rate limit during the cooldown window.
 *
 * Backoff schedule (resets to zero if last hit was >24h ago):
 *   1st hit in 24h:  30 min  ± 10% jitter
 *   2nd hit in 24h:  90 min  ± 10% jitter
 *   3rd+ hit in 24h: 4 hours ± 10% jitter
 *
 * State lives at `~/.ohwow/x-search-throttle.json` by default; tests and
 * threads-reply pass `{ stateFile }` to use an alternate path.
 *
 * All reads + writes are synchronous. The file is tiny (< 500 bytes)
 * and lookups happen once per scheduler tick, so the simplicity wins.
 * Writes are atomic via tmp + rename so a crashed daemon never leaves
 * a partial state file behind.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThrottleState {
  /** ISO timestamp until which all search requests should be skipped. */
  throttled_until: string | null;
  /** Count of hits within the 24h rolling window. Used for backoff ladder. */
  consecutive_hits: number;
  /** ISO timestamp of the most recent hit. Null when never hit. */
  last_hit_at: string | null;
  /** URL that tripped the most recent hit — useful for triage logs. */
  last_hit_url?: string | null;
  /** ISO timestamp of the most recent explicit/implicit recovery event. */
  last_recovery_at?: string | null;
}

/**
 * Thrown by `assertNotThrottled()` when the throttle is currently active.
 * Callers (tool entry points and schedulers) catch and either defer the
 * tick (scheduler) or surface a structured error (tool).
 */
export class XSearchThrottledError extends Error {
  public readonly code = 'THROTTLED' as const;
  public readonly retryAfter: Date;
  public readonly remainingMs: number;

  constructor(retryAfter: Date, remainingMs: number) {
    super(
      `x.com search is throttled until ${retryAfter.toISOString()} (${Math.max(0, Math.round(remainingMs / 1000))}s remaining).`,
    );
    this.name = 'XSearchThrottledError';
    this.retryAfter = retryAfter;
    this.remainingMs = remainingMs;
  }
}

export interface ThrottleTrackerOptions {
  /** Override state file path. Defaults to ~/.ohwow/x-search-throttle.json. */
  stateFile?: string;
  /** Override log tag emitted with pino events. Defaults to "x". */
  logTag?: string;
}

// ---------------------------------------------------------------------------
// Backoff ladder
// ---------------------------------------------------------------------------

const ONE_MINUTE_MS = 60 * 1000;
const THIRTY_MIN_MS = 30 * ONE_MINUTE_MS;
const NINETY_MIN_MS = 90 * ONE_MINUTE_MS;
const FOUR_HOUR_MS = 4 * 60 * ONE_MINUTE_MS;
const TWENTY_FOUR_HOUR_MS = 24 * 60 * ONE_MINUTE_MS;

/**
 * Deterministic-within-jitter backoff. 1st hit = 30m, 2nd = 90m,
 * 3rd+ = 4h. Each value is multiplied by (1 ± 0.1) random jitter so
 * parallel ohwow installs don't retry in lockstep.
 */
function backoffForHits(hits: number): number {
  const base = hits <= 1 ? THIRTY_MIN_MS : hits === 2 ? NINETY_MIN_MS : FOUR_HOUR_MS;
  const jitter = 1 + (Math.random() * 0.2 - 0.1); // ±10%
  return Math.round(base * jitter);
}

// ---------------------------------------------------------------------------
// Default paths
// ---------------------------------------------------------------------------

export const DEFAULT_X_THROTTLE_STATE_FILE = path.join(os.homedir(), '.ohwow', 'x-search-throttle.json');
export const DEFAULT_THREADS_THROTTLE_STATE_FILE = path.join(
  os.homedir(),
  '.ohwow',
  'threads-search-throttle.json',
);

// ---------------------------------------------------------------------------
// Tracker factory — pure + injectable
// ---------------------------------------------------------------------------

export interface ThrottleTracker {
  readState: () => ThrottleState;
  writeState: (state: ThrottleState) => void;
  isThrottled: (now?: Date) => { throttled: boolean; until: Date | null; remainingMs: number };
  markThrottled: (url: string, now?: Date) => ThrottleState;
  markRecovered: (now?: Date) => ThrottleState;
  assertNotThrottled: (now?: Date) => void;
}

const EMPTY_STATE: ThrottleState = {
  throttled_until: null,
  consecutive_hits: 0,
  last_hit_at: null,
  last_hit_url: null,
  last_recovery_at: null,
};

/**
 * Build a throttle tracker bound to a specific state file + log tag.
 * X and Threads each get their own tracker so their cooldowns don't
 * contaminate each other.
 */
export function createThrottleTracker(opts: ThrottleTrackerOptions = {}): ThrottleTracker {
  const stateFile = opts.stateFile ?? DEFAULT_X_THROTTLE_STATE_FILE;
  const logTag = opts.logTag ?? 'x';

  function readState(): ThrottleState {
    try {
      if (!fs.existsSync(stateFile)) return { ...EMPTY_STATE };
      const raw = fs.readFileSync(stateFile, 'utf8');
      if (!raw.trim()) return { ...EMPTY_STATE };
      const parsed = JSON.parse(raw) as Partial<ThrottleState>;
      return {
        throttled_until: typeof parsed.throttled_until === 'string' ? parsed.throttled_until : null,
        consecutive_hits: typeof parsed.consecutive_hits === 'number' ? parsed.consecutive_hits : 0,
        last_hit_at: typeof parsed.last_hit_at === 'string' ? parsed.last_hit_at : null,
        last_hit_url: typeof parsed.last_hit_url === 'string' ? parsed.last_hit_url : null,
        last_recovery_at: typeof parsed.last_recovery_at === 'string' ? parsed.last_recovery_at : null,
      };
    } catch (err) {
      // Corrupt state file: log once and reset. Better to forget a
      // cooldown than to block the scraper forever on a bad JSON parse.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), stateFile, platform: logTag },
        '[x-search-throttle] state file unreadable; resetting to empty',
      );
      return { ...EMPTY_STATE };
    }
  }

  function writeState(state: ThrottleState): void {
    const dir = path.dirname(stateFile);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // mkdir races are fine
    }
    // Atomic write: write to a tmp sibling then rename. rename on a
    // single filesystem is atomic on POSIX, so readers never observe a
    // half-written file.
    const tmp = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
    const payload = JSON.stringify(state, null, 2);
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }

  function isThrottled(now: Date = new Date()): { throttled: boolean; until: Date | null; remainingMs: number } {
    const state = readState();
    if (!state.throttled_until) return { throttled: false, until: null, remainingMs: 0 };
    const until = new Date(state.throttled_until);
    if (Number.isNaN(until.getTime())) {
      return { throttled: false, until: null, remainingMs: 0 };
    }
    const remainingMs = until.getTime() - now.getTime();
    if (remainingMs <= 0) {
      // Window has naturally expired. Emit the implicit recovery event
      // exactly once by clearing throttled_until + stamping
      // last_recovery_at. We deliberately DO NOT reset consecutive_hits
      // here — that's the 24h-rolling-window job, handled in
      // markThrottled.
      if (!state.last_recovery_at || state.last_recovery_at < state.throttled_until) {
        const next: ThrottleState = {
          ...state,
          throttled_until: null,
          last_recovery_at: now.toISOString(),
        };
        writeState(next);
        logger.info(
          {
            event: 'x_search_resumed',
            platform: logTag,
            consecutive_hits: next.consecutive_hits,
            expired_at: until.toISOString(),
            trigger: 'window_expired',
          },
          '[x-search-throttle] cooldown window expired; search resumed',
        );
      }
      return { throttled: false, until, remainingMs: 0 };
    }
    return { throttled: true, until, remainingMs };
  }

  function markThrottled(url: string, now: Date = new Date()): ThrottleState {
    const prev = readState();

    // Rolling 24h window: reset consecutive_hits if the previous hit
    // was more than 24h ago. A throttle event that lands inside an
    // already-active cooldown still advances the ladder — that's the
    // "scraper ignored us and retried" case we want to punish harder.
    let consecutive = prev.consecutive_hits;
    if (prev.last_hit_at) {
      const lastHit = new Date(prev.last_hit_at).getTime();
      if (!Number.isNaN(lastHit) && now.getTime() - lastHit > TWENTY_FOUR_HOUR_MS) {
        consecutive = 0;
      }
    } else {
      consecutive = 0;
    }
    consecutive += 1;

    const waitMs = backoffForHits(consecutive);
    const until = new Date(now.getTime() + waitMs);
    const next: ThrottleState = {
      throttled_until: until.toISOString(),
      consecutive_hits: consecutive,
      last_hit_at: now.toISOString(),
      last_hit_url: url,
      last_recovery_at: prev.last_recovery_at ?? null,
    };
    writeState(next);

    logger.warn(
      {
        event: 'x_search_rate_limited',
        platform: logTag,
        url,
        consecutive_hits: consecutive,
        wait_ms: waitMs,
        throttled_until: until.toISOString(),
      },
      '[x-search-throttle] rate limit hit; cooldown armed',
    );

    return next;
  }

  function markRecovered(now: Date = new Date()): ThrottleState {
    const prev = readState();
    const next: ThrottleState = {
      ...prev,
      throttled_until: null,
      last_recovery_at: now.toISOString(),
    };
    writeState(next);
    logger.info(
      {
        event: 'x_search_resumed',
        platform: logTag,
        consecutive_hits: next.consecutive_hits,
        trigger: 'explicit',
      },
      '[x-search-throttle] recovery marked; search resumed',
    );
    return next;
  }

  function assertNotThrottled(now: Date = new Date()): void {
    const status = isThrottled(now);
    if (status.throttled && status.until) {
      throw new XSearchThrottledError(status.until, status.remainingMs);
    }
  }

  return {
    readState,
    writeState,
    isThrottled,
    markThrottled,
    markRecovered,
    assertNotThrottled,
  };
}

// ---------------------------------------------------------------------------
// Default X tracker — the public functions named in the interface doc.
// ---------------------------------------------------------------------------

const defaultXTracker = createThrottleTracker({
  stateFile: DEFAULT_X_THROTTLE_STATE_FILE,
  logTag: 'x',
});

export function readThrottleState(): ThrottleState {
  return defaultXTracker.readState();
}

export function writeThrottleState(state: ThrottleState): void {
  defaultXTracker.writeState(state);
}

export function isThrottled(now?: Date): { throttled: boolean; until: Date | null; remainingMs: number } {
  return defaultXTracker.isThrottled(now);
}

export function markThrottled(url: string, now?: Date): ThrottleState {
  return defaultXTracker.markThrottled(url, now);
}

export function markRecovered(now?: Date): ThrottleState {
  return defaultXTracker.markRecovered(now);
}

export function assertNotThrottled(now?: Date): void {
  defaultXTracker.assertNotThrottled(now);
}

// ---------------------------------------------------------------------------
// Threads tracker — separate state file so X/Threads cooldowns are
// independent. They are distinct services with distinct rate limits.
// ---------------------------------------------------------------------------

export const threadsThrottleTracker = createThrottleTracker({
  stateFile: DEFAULT_THREADS_THROTTLE_STATE_FILE,
  logTag: 'threads',
});

// ---------------------------------------------------------------------------
// Detection helpers — shared signature across production scrapers.
// ---------------------------------------------------------------------------

/**
 * Given what a fresh x.com/search scrape returned, decide whether the
 * response is the X error-shell ("Something went wrong. Try reloading.")
 * with zero articles rendered. The scheduler catches this, calls
 * `markThrottled(url)`, and aborts remaining queries for the tick.
 *
 * Callers pass the observable page body text + parsed article count.
 * Keeping detection a pure function here keeps x-reply.ts / threads-reply.ts
 * lean and lets us unit-test the rule without spinning up a browser.
 */
export function looksLikeXSearchRateLimit(bodyText: string | null | undefined, articleCount: number): boolean {
  if (articleCount > 0) return false;
  const body = (bodyText ?? '').toLowerCase();
  if (!body) return false;
  // X's error shell text. Keep the match loose so a future copy tweak
  // ("something went wrong — try reloading" → "something went wrong. try
  // again later") still trips the detector.
  if (body.includes('something went wrong')) return true;
  if (body.includes('try reloading')) return true;
  return false;
}
