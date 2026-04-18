import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createThrottleTracker,
  XSearchThrottledError,
  looksLikeXSearchRateLimit,
  type ThrottleState,
} from '../x-search-throttle.js';

/**
 * Contract:
 *   - State file is injectable via createThrottleTracker({ stateFile }).
 *   - Fresh state (file missing) → isThrottled() returns false.
 *   - markThrottled() writes atomically (tmp + rename), bumps
 *     consecutive_hits, picks from the 30m / 90m / 4h ladder with ±10%
 *     jitter.
 *   - Rolling 24h window: a hit landing >24h after the previous one
 *     resets consecutive_hits to 1 before backoff math runs.
 *   - assertNotThrottled throws XSearchThrottledError with retryAfter +
 *     remainingMs populated.
 *   - markRecovered clears throttled_until but preserves consecutive_hits
 *     (a manual "I'm unblocked" ack shouldn't forgive the ladder
 *     position — next hit should still escalate).
 */

const ONE_MIN = 60 * 1000;
const THIRTY_MIN = 30 * ONE_MIN;
const NINETY_MIN = 90 * ONE_MIN;
const FOUR_HOUR = 4 * 60 * ONE_MIN;
const TWENTY_FIVE_HOUR = 25 * 60 * ONE_MIN;

describe('x-search-throttle', () => {
  let tempDir: string;
  let stateFile: string;
  let tracker: ReturnType<typeof createThrottleTracker>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-search-throttle-'));
    stateFile = path.join(tempDir, 'x-search-throttle.json');
    tracker = createThrottleTracker({ stateFile, logTag: 'x-test' });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  describe('fresh state', () => {
    it('reports not throttled when state file is missing', () => {
      expect(fs.existsSync(stateFile)).toBe(false);
      const status = tracker.isThrottled();
      expect(status.throttled).toBe(false);
      expect(status.until).toBeNull();
      expect(status.remainingMs).toBe(0);
    });

    it('assertNotThrottled does not throw on fresh state', () => {
      expect(() => tracker.assertNotThrottled()).not.toThrow();
    });

    it('readState returns zeroed state when file is missing', () => {
      const s = tracker.readState();
      expect(s).toEqual({
        throttled_until: null,
        consecutive_hits: 0,
        last_hit_at: null,
        last_hit_url: null,
        last_recovery_at: null,
      });
    });
  });

  describe('markThrottled ladder', () => {
    it('first hit within 24h → ~30 min block', () => {
      const now = new Date('2026-04-18T12:00:00Z');
      const s = tracker.markThrottled('https://x.com/search?q=solopreneur', now);

      expect(s.consecutive_hits).toBe(1);
      expect(s.last_hit_url).toBe('https://x.com/search?q=solopreneur');
      expect(s.last_hit_at).toBe(now.toISOString());
      expect(s.throttled_until).not.toBeNull();

      const until = new Date(s.throttled_until!).getTime();
      const waitMs = until - now.getTime();
      // 30m ± 10% → [27m, 33m]
      expect(waitMs).toBeGreaterThanOrEqual(THIRTY_MIN * 0.9 - 10);
      expect(waitMs).toBeLessThanOrEqual(THIRTY_MIN * 1.1 + 10);
    });

    it('writes state file atomically (tmp + rename leaves no sibling)', () => {
      tracker.markThrottled('https://x.com/search?q=x', new Date());
      expect(fs.existsSync(stateFile)).toBe(true);

      // No leftover tmp files in the state dir.
      const siblings = fs.readdirSync(path.dirname(stateFile));
      const tmpLeftover = siblings.filter((f) => f.includes('.tmp-'));
      expect(tmpLeftover).toEqual([]);

      // File parses as the expected shape.
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as ThrottleState;
      expect(parsed.consecutive_hits).toBe(1);
      expect(typeof parsed.throttled_until).toBe('string');
    });

    it('second hit within 24h → ~90 min block and consecutive_hits=2', () => {
      const t0 = new Date('2026-04-18T12:00:00Z');
      tracker.markThrottled('https://x.com/search?q=a', t0);

      // Second hit 1 hour later (inside the 24h window).
      const t1 = new Date(t0.getTime() + 60 * ONE_MIN);
      const s2 = tracker.markThrottled('https://x.com/search?q=b', t1);

      expect(s2.consecutive_hits).toBe(2);
      const until = new Date(s2.throttled_until!).getTime();
      const waitMs = until - t1.getTime();
      expect(waitMs).toBeGreaterThanOrEqual(NINETY_MIN * 0.9 - 10);
      expect(waitMs).toBeLessThanOrEqual(NINETY_MIN * 1.1 + 10);
    });

    it('third hit within 24h → ~4 hour block and consecutive_hits=3', () => {
      const t0 = new Date('2026-04-18T12:00:00Z');
      tracker.markThrottled('https://x.com/search?q=a', t0);
      tracker.markThrottled('https://x.com/search?q=b', new Date(t0.getTime() + 30 * ONE_MIN));
      const t2 = new Date(t0.getTime() + 120 * ONE_MIN);
      const s3 = tracker.markThrottled('https://x.com/search?q=c', t2);

      expect(s3.consecutive_hits).toBe(3);
      const waitMs = new Date(s3.throttled_until!).getTime() - t2.getTime();
      expect(waitMs).toBeGreaterThanOrEqual(FOUR_HOUR * 0.9 - 10);
      expect(waitMs).toBeLessThanOrEqual(FOUR_HOUR * 1.1 + 10);
    });

    it('hit >24h after last_hit resets consecutive to 1 → back to 30 min', () => {
      const t0 = new Date('2026-04-18T12:00:00Z');
      // Seed with 2 prior hits so consecutive_hits=2 is on file.
      tracker.markThrottled('https://x.com/search?q=a', t0);
      tracker.markThrottled('https://x.com/search?q=b', new Date(t0.getTime() + 30 * ONE_MIN));

      // 25 hours later, a fresh hit lands. Rolling window forgives.
      const tLate = new Date(t0.getTime() + TWENTY_FIVE_HOUR);
      const sFresh = tracker.markThrottled('https://x.com/search?q=c', tLate);

      expect(sFresh.consecutive_hits).toBe(1);
      const waitMs = new Date(sFresh.throttled_until!).getTime() - tLate.getTime();
      expect(waitMs).toBeGreaterThanOrEqual(THIRTY_MIN * 0.9 - 10);
      expect(waitMs).toBeLessThanOrEqual(THIRTY_MIN * 1.1 + 10);
    });
  });

  describe('isThrottled lifecycle', () => {
    it('returns false past throttled_until and emits implicit recovery', () => {
      const t0 = new Date('2026-04-18T12:00:00Z');
      tracker.markThrottled('https://x.com/search?q=a', t0);

      // Fast-forward past the block (even a 33m max jitter window).
      const t1 = new Date(t0.getTime() + FOUR_HOUR);
      const status = tracker.isThrottled(t1);

      expect(status.throttled).toBe(false);
      expect(status.remainingMs).toBe(0);

      // Implicit recovery should have stamped last_recovery_at and
      // cleared throttled_until.
      const persisted = tracker.readState();
      expect(persisted.throttled_until).toBeNull();
      expect(persisted.last_recovery_at).toBe(t1.toISOString());
      // But consecutive_hits sticks — next hit inside 24h still escalates.
      expect(persisted.consecutive_hits).toBe(1);
    });

    it('still throttled inside the window', () => {
      const t0 = new Date('2026-04-18T12:00:00Z');
      tracker.markThrottled('https://x.com/search?q=a', t0);
      const t1 = new Date(t0.getTime() + 5 * ONE_MIN);
      const status = tracker.isThrottled(t1);
      expect(status.throttled).toBe(true);
      expect(status.until).not.toBeNull();
      expect(status.remainingMs).toBeGreaterThan(0);
    });
  });

  describe('assertNotThrottled', () => {
    it('throws XSearchThrottledError with retryAfter + remainingMs', () => {
      const t0 = new Date('2026-04-18T12:00:00Z');
      tracker.markThrottled('https://x.com/search?q=a', t0);
      const t1 = new Date(t0.getTime() + 5 * ONE_MIN);

      let caught: XSearchThrottledError | null = null;
      try {
        tracker.assertNotThrottled(t1);
      } catch (err) {
        if (err instanceof XSearchThrottledError) caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught!.code).toBe('THROTTLED');
      expect(caught!.retryAfter).toBeInstanceOf(Date);
      expect(caught!.remainingMs).toBeGreaterThan(0);
      expect(caught!.message).toContain('throttled');
    });

    it('does not throw after the window has passed', () => {
      const t0 = new Date('2026-04-18T12:00:00Z');
      tracker.markThrottled('https://x.com/search?q=a', t0);
      const t1 = new Date(t0.getTime() + FOUR_HOUR);
      expect(() => tracker.assertNotThrottled(t1)).not.toThrow();
    });
  });

  describe('markRecovered', () => {
    it('clears throttled_until but preserves consecutive_hits', () => {
      const t0 = new Date('2026-04-18T12:00:00Z');
      tracker.markThrottled('https://x.com/search?q=a', t0);
      tracker.markThrottled('https://x.com/search?q=b', new Date(t0.getTime() + 20 * ONE_MIN));

      const prev = tracker.readState();
      expect(prev.consecutive_hits).toBe(2);
      expect(prev.throttled_until).not.toBeNull();

      const t1 = new Date(t0.getTime() + 30 * ONE_MIN);
      const recovered = tracker.markRecovered(t1);

      expect(recovered.throttled_until).toBeNull();
      expect(recovered.consecutive_hits).toBe(2);
      expect(recovered.last_recovery_at).toBe(t1.toISOString());

      // isThrottled immediately reflects it.
      expect(tracker.isThrottled(t1).throttled).toBe(false);
    });
  });

  describe('corrupt state recovery', () => {
    it('treats an unreadable state file as empty instead of throwing', () => {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, '{not valid json');
      const s = tracker.readState();
      expect(s.throttled_until).toBeNull();
      expect(s.consecutive_hits).toBe(0);
      expect(() => tracker.assertNotThrottled()).not.toThrow();
    });
  });

  describe('looksLikeXSearchRateLimit', () => {
    it('matches the "Something went wrong" error shell with zero articles', () => {
      expect(
        looksLikeXSearchRateLimit("Something went wrong. Try reloading.", 0),
      ).toBe(true);
    });
    it('matches "try reloading" variant', () => {
      expect(looksLikeXSearchRateLimit('please Try Reloading the page', 0)).toBe(true);
    });
    it('ignores the error copy when articles did render', () => {
      expect(
        looksLikeXSearchRateLimit('Something went wrong below an article', 3),
      ).toBe(false);
    });
    it('returns false on empty body', () => {
      expect(looksLikeXSearchRateLimit('', 0)).toBe(false);
      expect(looksLikeXSearchRateLimit(null, 0)).toBe(false);
      expect(looksLikeXSearchRateLimit(undefined, 0)).toBe(false);
    });
  });
});
