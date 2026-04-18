/**
 * Cross-process X search throttle state + integration with scrollAndHarvest's
 * pre-flight check. We validate:
 *   - write / read round-trip
 *   - markThrottled computes the right backoff tier and persists it
 *   - consecutive_hits resets after 24h
 *   - assertNotThrottled throws with retryAfter / remainingMs populated
 *   - scrollAndHarvest pre-flight refuses to load a search URL when a
 *     cooldown is live, without invoking page.goto
 *   - scrollAndHarvest pre-flight ignores non-search URLs (profile, home)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  readThrottleState,
  writeThrottleState,
  isThrottled,
  markThrottled,
  markRecovered,
  assertNotThrottled,
  XSearchThrottledError,
} from '../../../src/lib/x-search-throttle.ts';
import { scrollAndHarvest, XSearchRateLimitedError } from '../_x-harvest.mjs';

let tmpHome;
let origHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'x-throttle-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // Also clear any env-level override so tests share the default state path.
  delete process.env.OHWOW_X_THROTTLE_STATE_FILE;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('x-search-throttle state', () => {
  it('returns an empty state when the file does not exist', () => {
    const s = readThrottleState();
    expect(s.throttled_until).toBeNull();
    expect(s.consecutive_hits).toBe(0);
  });

  it('round-trips state through write + read', () => {
    writeThrottleState({
      throttled_until: '2026-04-18T12:00:00.000Z',
      consecutive_hits: 2,
      last_hit_at: '2026-04-18T11:00:00.000Z',
      last_hit_url: 'https://x.com/search?q=foo',
      last_recovery_at: null,
    });
    const s = readThrottleState();
    expect(s.consecutive_hits).toBe(2);
    expect(s.last_hit_url).toBe('https://x.com/search?q=foo');
  });

  it('isThrottled reports false when the cooldown has already elapsed', () => {
    writeThrottleState({
      throttled_until: new Date(Date.now() - 1000).toISOString(),
      consecutive_hits: 1,
      last_hit_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const g = isThrottled();
    expect(g.throttled).toBe(false);
  });

  it('isThrottled reports true with remainingMs when the cooldown is live', () => {
    writeThrottleState({
      throttled_until: new Date(Date.now() + 5 * 60_000).toISOString(),
      consecutive_hits: 1,
      last_hit_at: new Date().toISOString(),
    });
    const g = isThrottled();
    expect(g.throttled).toBe(true);
    expect(g.remainingMs).toBeGreaterThan(4 * 60_000);
    expect(g.remainingMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it('markThrottled on a fresh state records consecutive_hits=1 and a 30min-ish cooldown', () => {
    const now = new Date('2026-04-18T12:00:00Z');
    const s = markThrottled('https://x.com/search?q=agents', now);
    expect(s.consecutive_hits).toBe(1);
    const untilMs = new Date(s.throttled_until).getTime();
    const deltaMin = (untilMs - now.getTime()) / 60_000;
    // 30 min base ± 10% jitter = [27, 33]
    expect(deltaMin).toBeGreaterThan(27);
    expect(deltaMin).toBeLessThan(33);
  });

  it('markThrottled twice in a row escalates to the 90min tier', () => {
    const now = new Date('2026-04-18T12:00:00Z');
    markThrottled('https://x.com/search?q=first', now);
    const second = markThrottled('https://x.com/search?q=second', new Date(now.getTime() + 60_000));
    expect(second.consecutive_hits).toBe(2);
    const untilMs = new Date(second.throttled_until).getTime();
    const deltaMin = (untilMs - (now.getTime() + 60_000)) / 60_000;
    // 90 min base ± 10% jitter = [81, 99]
    expect(deltaMin).toBeGreaterThan(81);
    expect(deltaMin).toBeLessThan(99);
  });

  it('markThrottled three times escalates to the 4h tier', () => {
    const now = new Date('2026-04-18T12:00:00Z');
    markThrottled('u1', now);
    markThrottled('u2', new Date(now.getTime() + 60_000));
    const third = markThrottled('u3', new Date(now.getTime() + 2 * 60_000));
    expect(third.consecutive_hits).toBe(3);
    const untilMs = new Date(third.throttled_until).getTime();
    const deltaMin = (untilMs - (now.getTime() + 2 * 60_000)) / 60_000;
    // 4h base ± 10% jitter = [216, 264]
    expect(deltaMin).toBeGreaterThan(216);
    expect(deltaMin).toBeLessThan(264);
  });

  it('consecutive_hits resets to 1 if the previous hit was >24h ago', () => {
    const old = new Date('2026-04-15T12:00:00Z');
    markThrottled('u_old', old);
    // 25h later
    const now = new Date(old.getTime() + 25 * 60 * 60_000);
    const fresh = markThrottled('u_now', now);
    expect(fresh.consecutive_hits).toBe(1);
  });

  it('markRecovered clears throttled_until but keeps consecutive_hits', () => {
    const now = new Date();
    markThrottled('u', now);
    const recovered = markRecovered(new Date(now.getTime() + 60_000));
    expect(recovered.throttled_until).toBeNull();
    expect(recovered.consecutive_hits).toBe(1);
    expect(recovered.last_recovery_at).toBeTruthy();
  });

  it('assertNotThrottled throws XSearchThrottledError with retryAfter set', () => {
    const now = new Date();
    markThrottled('https://x.com/search?q=x', now);
    let caught;
    try { assertNotThrottled(new Date(now.getTime() + 1000)); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(XSearchThrottledError);
    expect(caught.code).toBe('THROTTLED');
    expect(caught.retryAfter).toBeInstanceOf(Date);
    expect(caught.remainingMs).toBeGreaterThan(0);
  });

  it('assertNotThrottled is a no-op when no cooldown is live', () => {
    expect(() => assertNotThrottled()).not.toThrow();
  });
});

describe('scrollAndHarvest pre-flight', () => {
  function fakePage() {
    const calls = { goto: 0, evaluate: 0 };
    return {
      calls,
      async goto() { calls.goto++; },
      async evaluate(js) {
        calls.evaluate++;
        // The in-flight error-shell check looks for the throttle signature;
        // our fake reports "no error" so the scroll loop proceeds.
        if (typeof js === 'string' && js.includes('Something went wrong')) return false;
        // All other evaluates (HARVEST_JS + scroll commands) return a
        // neutral no-op payload. Returning `[]` for HARVEST_JS mimics a
        // page that rendered but found no articles — harmless here.
        return [];
      },
      async pressKey() {},
    };
  }

  it('refuses to load a search URL when the throttle is live and throws XSearchRateLimitedError', async () => {
    markThrottled('https://x.com/search?q=anything', new Date());
    const page = fakePage();
    let caught;
    try {
      await scrollAndHarvest(page, 'https://x.com/search?q=foo&f=live', 2);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(XSearchRateLimitedError);
    expect(page.calls.goto).toBe(0); // cheap branch — never touched the browser
  });

  it('does NOT pre-flight non-search URLs (profile, home, status)', async () => {
    markThrottled('https://x.com/search?q=anything', new Date());
    const page = fakePage();
    // Home feed is a different RPC and is not governed by the search budget.
    // The pre-flight should not block it.
    await scrollAndHarvest(page, 'https://x.com/home', 1);
    expect(page.calls.goto).toBe(1);
  });

  it('allows search URLs through once the cooldown elapses', async () => {
    writeThrottleState({
      throttled_until: new Date(Date.now() - 1000).toISOString(),
      consecutive_hits: 1,
      last_hit_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const page = fakePage();
    await scrollAndHarvest(page, 'https://x.com/search?q=recovered&f=live', 1);
    expect(page.calls.goto).toBe(1);
  });
});
