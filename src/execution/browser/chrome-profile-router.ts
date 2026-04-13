/**
 * Chrome Profile Router — correlates CDP page targets to Chrome profiles.
 *
 * ohwow's debug Chrome can run multiple profile windows simultaneously
 * inside a single Chrome process (see chrome-lifecycle.ts). Each window
 * loads cookies from its own profile directory, but CDP/Playwright
 * collapse all of them under one "default" browser context. If you just
 * call `browser.contexts()[0].pages()`, you get pages from every
 * profile intermingled, with no metadata telling you which cookies
 * each one has access to.
 *
 * This module is the correlation layer. Given a running debug Chrome
 * and a target profile (by email, directory name, or local display
 * name), it returns a Playwright Page attached to a CDP target IN
 * THAT profile's window. Two identification signals are combined:
 *
 *   1. **macOS osascript window titles.** When multiple profiles are
 *      running, Chrome appends ` - <localProfileName>` to every
 *      window's title. We fetch the window title list, parse out the
 *      suffixes, and build a title→profile map. Then for each CDP
 *      page we look up its Playwright `title()` in the map.
 *
 *   2. **Per-page avatar probe.** Fallback for non-macOS or for
 *      windows whose titles don't carry a profile suffix (single-
 *      profile Chrome, or profile names that collide). Navigates
 *      the page (if a urlHint is supplied) and reads a known user
 *      identifier from the DOM (e.g. a Product Hunt `a[href^="/@"]`
 *      link, which holds the handle of the logged-in user). The
 *      caller supplies the expected identity and we match.
 *
 * When a profile window doesn't exist yet, the router asks
 * chrome-lifecycle to open one via `open -a`, waits for the new CDP
 * target, and retries the correlation.
 *
 * Experimentally verified 2026-04-13: macOS osascript was able to
 * distinguish windows labeled `- Jesus` (Profile 2) from `- ohwow.fun`
 * (Profile 1) on a running debug Chrome containing both, even though
 * Playwright's `browser.contexts()` reported only one context.
 */

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { logger } from '../../lib/logger.js';
import {
  ChromeLifecycleError,
  DEFAULT_CDP_PORT,
  findProfileByIdentity,
  listChromeWindowTitlesMac,
  listProfiles,
  openProfileWindow,
  parseWindowTitleSuffix,
  type ProfileInfo,
} from './chrome-lifecycle.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteToProfileOptions {
  /** Connected Playwright Browser (output of chromium.connectOverCDP). */
  browser: Browser;
  /** Which profile do we want a page in? email, directory name, or localProfileName. */
  profile: string;
  /**
   * Optional URL the caller wants the returned page navigated to. If
   * supplied, we navigate the routed page to this URL before returning.
   * Useful for "give me a page in Profile 2 loaded to PH /my/products".
   */
  urlHint?: string;
  /**
   * Optional per-profile validation callback. Called with the candidate
   * page after we think it's in the right profile. Should return true
   * if the page looks correct (e.g. reads the PH avatar and confirms
   * the expected handle). Default: always true.
   */
  validate?: (page: Page) => Promise<boolean>;
  /** CDP port; defaults to DEFAULT_CDP_PORT. */
  port?: number;
  /** Max time to wait for a profile window to open + be routable. */
  timeoutMs?: number;
}

export interface RouteResult {
  page: Page;
  profile: ProfileInfo;
  matchReason: 'title-suffix' | 'validate-callback' | 'only-candidate';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten all pages in a Browser. Playwright collapses Chrome profiles
 * into a single default BrowserContext, so one context.pages() call is
 * sufficient — but we defensively iterate every context anyway in case
 * the user has an incognito profile open too.
 */
function flattenPages(browser: Browser): Page[] {
  const out: Page[] = [];
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) out.push(p);
  }
  return out;
}

/**
 * Get the Chrome window-title→profile suffix map via osascript, then
 * correlate each page's current title to a window. Returns a Map
 * keyed on Page object.
 */
async function buildPageToSuffixMapMac(pages: Page[]): Promise<Map<Page, string>> {
  const titles = await listChromeWindowTitlesMac();
  const suffixes = new Map<string, string>(); // titleWithoutSuffix → suffix
  for (const t of titles) {
    const suffix = parseWindowTitleSuffix(t);
    if (suffix) {
      // Key on the title MINUS the suffix for robust lookups.
      const prefix = t.slice(0, t.length - (` - Google Chrome - ${suffix}`).length);
      suffixes.set(prefix.trim(), suffix);
    }
  }
  const out = new Map<Page, string>();
  for (const page of pages) {
    try {
      const pageTitle = await page.title();
      // Chrome's window title format:
      //   "<page title> - Google Chrome - <profileSuffix>"
      // and sometimes "<page title> - Pinned - Google Chrome - <profileSuffix>".
      // We iterate the suffixes map looking for a prefix that startsWith
      // the page's title (accounts for the "- Pinned -" inflection).
      for (const [prefix, suffix] of suffixes) {
        if (prefix.startsWith(pageTitle) || pageTitle.startsWith(prefix.split(' - Pinned')[0])) {
          out.set(page, suffix);
          break;
        }
      }
    } catch {
      // Page closed or detached — skip.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public routing function
// ---------------------------------------------------------------------------

/**
 * Return a Playwright Page that is IN the requested Chrome profile's
 * window. If no such window exists, ask chrome-lifecycle to open one
 * and retry. If multiple candidates exist, prefer the one whose URL
 * already matches `urlHint` (small optimization) or pass through the
 * caller's `validate` predicate.
 */
export async function routeToProfile(opts: RouteToProfileOptions): Promise<RouteResult> {
  const port = opts.port ?? DEFAULT_CDP_PORT;
  const timeoutMs = opts.timeoutMs ?? 10000;

  const profiles = listProfiles();
  const target = findProfileByIdentity(profiles, opts.profile);
  if (!target) {
    throw new ChromeLifecycleError(
      'PROFILE_NOT_FOUND',
      `No profile matching "${opts.profile}" in debug Chrome. Available profiles: ${profiles.map((p) => `${p.directory} (${p.email ?? 'no-email'})`).join(', ') || '(none)'}`,
      { requested: opts.profile, available: profiles.map((p) => ({ directory: p.directory, email: p.email })) },
    );
  }

  logger.debug(
    { profile: target.directory, email: target.email },
    '[chrome-profile-router] looking for page in profile',
  );

  // Try routing. If we can't find a candidate, open a window and retry.
  const deadline = Date.now() + timeoutMs;
  let opened = false;
  while (Date.now() < deadline) {
    const result = await tryRoute(opts.browser, target, opts.urlHint, opts.validate);
    if (result) {
      if (opts.urlHint && result.page.url() !== opts.urlHint) {
        await result.page.goto(opts.urlHint, { waitUntil: 'domcontentloaded' }).catch((e) => {
          logger.warn({ err: e instanceof Error ? e.message : e }, '[chrome-profile-router] urlHint goto failed');
        });
      }
      return result;
    }

    if (!opened) {
      logger.info(
        { profileDir: target.directory },
        '[chrome-profile-router] no candidate page found, opening profile window',
      );
      try {
        await openProfileWindow({ profileDir: target.directory, port });
      } catch (err) {
        if (err instanceof ChromeLifecycleError) throw err;
        throw new ChromeLifecycleError(
          'PROFILE_WINDOW_TIMEOUT',
          `openProfileWindow failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      opened = true;
      // Loop back to retry the route now that a new window exists.
      continue;
    }

    // Opened once and still no match — wait a beat and try again.
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new ChromeLifecycleError(
    'PROFILE_WINDOW_TIMEOUT',
    `Opened window for "${target.directory}" but routing still couldn't find a page in that profile after ${timeoutMs}ms`,
  );
}

/**
 * One attempt at routing: enumerate pages, correlate to profile
 * suffixes, return the best match. No window-opening. No retries.
 */
async function tryRoute(
  browser: Browser,
  target: ProfileInfo,
  urlHint: string | undefined,
  validate: RouteToProfileOptions['validate'],
): Promise<RouteResult | null> {
  const pages = flattenPages(browser);
  if (pages.length === 0) return null;

  // Stage 1: macOS title-suffix correlation.
  const suffixMap = await buildPageToSuffixMapMac(pages);

  const candidates: Array<{ page: Page; reason: RouteResult['matchReason'] }> = [];
  if (target.localProfileName) {
    const wantSuffix = target.localProfileName;
    for (const [page, suffix] of suffixMap) {
      if (suffix === wantSuffix) candidates.push({ page, reason: 'title-suffix' });
    }
  }

  // Stage 2: if no suffix match and caller supplied a validator, try every page.
  if (candidates.length === 0 && validate) {
    for (const page of pages) {
      try {
        if (await validate(page)) {
          candidates.push({ page, reason: 'validate-callback' });
        }
      } catch {
        // Page closed mid-validation — skip.
      }
    }
  }

  if (candidates.length === 0) return null;

  // Prefer the candidate already on the urlHint, then the first one.
  let chosen = candidates[0];
  if (urlHint) {
    const pref = candidates.find((c) => c.page.url() === urlHint || c.page.url().startsWith(urlHint));
    if (pref) chosen = pref;
  }
  if (candidates.length === 1) {
    chosen = { ...chosen, reason: 'only-candidate' };
  }

  return { page: chosen.page, profile: target, matchReason: chosen.reason };
}

/**
 * Debug helper: return a description of every page and which profile
 * suffix it maps to, for logging and troubleshooting. Not used on the
 * happy path. Returns one entry per open page target.
 */
export async function debugPageProfileMap(browser: Browser): Promise<
  Array<{ url: string; title: string; suffix: string | null }>
> {
  const pages = flattenPages(browser);
  const suffixMap = await buildPageToSuffixMapMac(pages);
  const out: Array<{ url: string; title: string; suffix: string | null }> = [];
  for (const p of pages) {
    try {
      out.push({
        url: p.url(),
        title: await p.title(),
        suffix: suffixMap.get(p) ?? null,
      });
    } catch {
      // page closed
    }
  }
  return out;
}

// Re-export everything callers typically need so chrome-lifecycle stays
// an implementation detail for most consumers.
export {
  DEBUG_DATA_DIR,
  DEFAULT_CDP_PORT,
  ChromeLifecycleError,
  listProfiles,
  findProfileByIdentity,
  openProfileWindow,
  ensureDebugChrome,
  quitDebugChrome,
  assertNoConsentPending,
} from './chrome-lifecycle.js';
export type { ProfileInfo, DebugChromeHandle } from './chrome-lifecycle.js';
