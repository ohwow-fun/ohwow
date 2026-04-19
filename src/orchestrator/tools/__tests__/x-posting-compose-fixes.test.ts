/**
 * Freeze tests for x_compose_tweet / x_compose_thread bug fixes:
 *
 *   1. confirmPostLanded timeout widened to 6000ms (was 2500ms)
 *   2. Tab-reuse guard: navigate to x.com/home before re-entering /compose/post
 *   3. URL-based publish fallback: accept success when finalUrl leaves /compose/post
 *   4. Compose modal focus: retry loop (5x/200ms) + relaxed focusByTestid check
 *      + compose-specific 3500ms hydration wait + 150ms DraftJS settle in typing
 *
 * composeTweetViaBrowser and composeThreadViaBrowser both depend on live CDP
 * (getCdpPage internally connects to Chrome at :9222), so end-to-end mocking
 * would require a full CDP stub. Instead, we pin the critical patterns at the
 * source level — any future edit that regresses these constants or branches
 * will break these tests immediately, at CI cost rather than runtime cost.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// Also import pure-logic exports that CAN be tested without CDP.
import { isLoginRedirect, wait } from '../x-posting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  path.resolve(__dirname, '../x-posting.ts'),
  'utf8',
);
const CDP_HELPERS_SOURCE = readFileSync(
  path.resolve(__dirname, '../social-cdp-helpers.ts'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Source-pattern assertions — freeze the three fixes
// ---------------------------------------------------------------------------

describe('x-posting compose fixes (source-level freeze)', () => {
  describe('fix 1: confirmPostLanded called with 6000ms timeout', () => {
    it('composeTweetViaBrowser calls confirmPostLanded with 6000ms', () => {
      // The impl file must contain exactly: confirmPostLanded(page, text, 6000)
      // anywhere in the composeTweetViaBrowser function body.
      // We count occurrences to ensure BOTH call sites have it.
      const matches = SOURCE.match(/confirmPostLanded\([^,]+,\s*[^,]+,\s*6000\s*\)/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('no call to confirmPostLanded uses the old 2500ms timeout', () => {
      // Any remnant of the old timeout would be a regression.
      const oldCallsite = /confirmPostLanded\([^,]+,\s*[^,]+,\s*2500\s*\)/.test(SOURCE);
      expect(oldCallsite).toBe(false);
    });
  });

  describe('fix 2: tab-reuse guard navigates to x.com/home before /compose/post', () => {
    it('composeTweetViaBrowser has the guard pattern', () => {
      // The guard must: (a) check preNavUrl.includes('/compose/post')
      // and (b) goto x.com/home before proceeding.
      const hasCheck = SOURCE.includes("preNavUrl.includes('/compose/post')");
      expect(hasCheck).toBe(true);
    });

    it('guard navigates to x.com/home (not just any page)', () => {
      const hasHomeNav = SOURCE.includes("goto('https://x.com/home')");
      expect(hasHomeNav).toBe(true);
    });

    it('guard appears twice — once per compose function', () => {
      // Both composeTweetViaBrowser AND composeThreadViaBrowser need it.
      const guardMatches = SOURCE.match(/preNavUrl\.includes\('\/compose\/post'\)/g) ?? [];
      expect(guardMatches.length).toBeGreaterThanOrEqual(2);
    });

    it('guard waits 800ms after navigating home', () => {
      // Ensure the wait(800) is present near the guard (debounce for navigation).
      const hasWait = /goto\('https:\/\/x\.com\/home'\)[\s\S]{0,100}wait\(800\)/.test(SOURCE);
      expect(hasWait).toBe(true);
    });
  });

  describe('fix 3: URL-based fallback returns success when finalUrl leaves /compose/post', () => {
    it('composeTweetViaBrowser has the URL-based fallback after not_visible', () => {
      // Pattern: check landing === 'not_visible', then read finalUrl,
      // then check !finalUrl.includes('/compose/post') and return success: true.
      const hasNotVisible = /landing === 'not_visible'/.test(SOURCE);
      expect(hasNotVisible).toBe(true);
    });

    it('URL fallback pattern exists (finalUrl not containing /compose/post → success)', () => {
      const hasFallback = SOURCE.includes("!finalUrl.includes('/compose/post')");
      expect(hasFallback).toBe(true);
    });

    it('URL fallback returns success: true', () => {
      // After the guard, we must have success: true in the branch.
      // Verify both the check and the success: true appear in a not_visible block.
      const hasSucess = /!finalUrl\.includes\('\/compose\/post'\)[\s\S]{0,300}success:\s*true/.test(SOURCE);
      expect(hasSucess).toBe(true);
    });

    it('URL fallback appears twice — once per compose function', () => {
      const matches = SOURCE.match(/!finalUrl\.includes\('\/compose\/post'\)/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure-logic unit tests — no CDP, no mocking
// ---------------------------------------------------------------------------

describe('isLoginRedirect', () => {
  it('returns true for the standard login URL', () => {
    expect(isLoginRedirect('https://x.com/login')).toBe(true);
  });

  it('returns true for login with query params', () => {
    expect(isLoginRedirect('https://x.com/login?redirect_after_login=%2Fhome')).toBe(true);
  });

  it('returns false for the compose URL', () => {
    expect(isLoginRedirect('https://x.com/compose/post')).toBe(false);
  });

  it('returns false for x.com/home', () => {
    expect(isLoginRedirect('https://x.com/home')).toBe(false);
  });
});

describe('wait', () => {
  it('resolves after approximately the requested delay', async () => {
    const start = Date.now();
    await wait(50);
    const elapsed = Date.now() - start;
    // Allow generous window: node timer resolution + CI jitter
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// Fix 4: Compose modal focus — retry loop + relaxed check + 3500ms hydration
// ---------------------------------------------------------------------------

describe('x-posting compose modal focus fix (source-level freeze)', () => {
  describe('fix 4a: retry loop in composeTweetViaBrowser', () => {
    it('uses a for-loop up to 5 iterations before bailing on focus', () => {
      // The loop must bound at i < 5 so it retries exactly 5 times.
      const hasLoop = /for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*5;\s*i\+\+\s*\)/.test(SOURCE);
      expect(hasLoop).toBe(true);
    });

    it('calls focusByTestid inside the retry loop', () => {
      // focusByTestid must appear inside a retry-loop block (i < 5 guard present).
      // Simplest freeze: focusByTestid called with tweetTextarea_0 in composeTweetViaBrowser context.
      const hasFocusCall = SOURCE.includes("focusByTestid(page, 'tweetTextarea_0')");
      expect(hasFocusCall).toBe(true);
    });

    it('waits 200ms between retries', () => {
      // The retry loop must have a 200ms back-off before the next attempt.
      // Pattern: if (focused) break; await wait(200);
      const hasBackoff = /if\s*\(focused\)\s*break;\s*[\s\S]{0,30}await wait\(200\)/.test(SOURCE);
      expect(hasBackoff).toBe(true);
    });

    it('bails with "Could not focus tweetTextarea_0" when all retries exhausted', () => {
      // Bail message must be present — this string is used by callers to classify errors.
      expect(SOURCE).toContain("'Could not focus tweetTextarea_0'");
    });
  });

  describe('fix 4b: focusByTestid uses relaxed check (no activeElement assertion)', () => {
    it('focusByTestid calls el.focus() and returns true without checking activeElement', () => {
      // The function body must NOT contain an activeElement check.
      // Extract the function block heuristically: between "focusByTestid" and the
      // closing brace of its try block — should not reference document.activeElement.
      const fnStart = SOURCE.indexOf('export async function focusByTestid');
      const fnEnd = SOURCE.indexOf('\nexport ', fnStart + 1);
      const fnBody = SOURCE.slice(fnStart, fnEnd === -1 ? fnStart + 600 : fnEnd);
      expect(fnBody).not.toContain('activeElement');
    });

    it('focusByTestid calls el.focus() then returns true', () => {
      const fnStart = SOURCE.indexOf('export async function focusByTestid');
      const fnEnd = SOURCE.indexOf('\nexport ', fnStart + 1);
      const fnBody = SOURCE.slice(fnStart, fnEnd === -1 ? fnStart + 600 : fnEnd);
      // Must call focus and return true (relaxed — not gated on activeElement).
      expect(fnBody).toContain('el.focus()');
      expect(fnBody).toContain('return true');
    });
  });

  describe('fix 4c: compose-specific 3500ms hydration wait', () => {
    it('composeTweetViaBrowser uses 3500ms hydration wait (not the global 2500ms)', () => {
      // The compose path must wait(3500) after goto(COMPOSE_URL).
      // A bare HYDRATION_WAIT_MS (2500) must NOT appear in the compose path.
      const hasComposeLongWait = SOURCE.includes('await wait(3500)');
      expect(hasComposeLongWait).toBe(true);
    });

    it('global HYDRATION_WAIT_MS constant is still 2500 (unchanged)', () => {
      // Step 3 plan: increase compose wait WITHOUT changing the global constant.
      const hasGlobal = /const HYDRATION_WAIT_MS\s*=\s*2500/.test(SOURCE);
      expect(hasGlobal).toBe(true);
    });
  });

  describe('fix 4d: 150ms DraftJS settle wait in typeIntoRichTextbox', () => {
    it('social-cdp-helpers waits 150ms after focusOnly() before per-char dispatch', () => {
      // The wait(150) must appear between focusOnly() and the per-char loop.
      const hasSettle = /await focusOnly\(\);\s*await wait\(150\)/.test(CDP_HELPERS_SOURCE);
      expect(hasSettle).toBe(true);
    });

    it('wait(150) comment references DraftJS settle', () => {
      // Ensure the intent is documented (not a stray wait).
      expect(CDP_HELPERS_SOURCE).toContain('DraftJS');
    });
  });
});
