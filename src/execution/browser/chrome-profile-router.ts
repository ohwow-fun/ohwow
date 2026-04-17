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
  ensureDebugChrome,
  findProfileByIdentity,
  listChromeWindowTitlesMac,
  listProfiles,
  openProfileWindow,
  parseWindowTitleSuffix,
  type ProfileInfo,
} from './chrome-lifecycle.js';
import { appendChromeProfileEvent } from './chrome-profile-ledger.js';
import { RawCdpBrowser } from './raw-cdp.js';

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

// ---------------------------------------------------------------------------
// Profile-pinned CDP connection for external callers
// ---------------------------------------------------------------------------

export interface ConnectAndPinOptions {
  /**
   * URL the caller wants opened in the target profile. Passed to
   * `openProfileWindow({url})` so Chrome creates a fresh tab in the
   * correct browserContextId and lands it on this URL. The returned
   * Page will also be re-`goto`'d to this URL by the underlying
   * `routeToProfile` call.
   */
  url: string;
  /**
   * Profile hint (email, directory name, or localProfileName). When
   * omitted, resolution falls back to `OHWOW_CHROME_PROFILE` env, then
   * the first profile with an email, then the first profile overall.
   * Same default chain `deliverable-executor.ensureProfileChrome` uses.
   */
  profile?: string;
  port?: number;
  timeoutMs?: number;
}

export interface ConnectAndPinResult {
  /**
   * Live Playwright Browser handle. Caller is responsible for closing
   * it when done (or letting GC reclaim — the underlying CDP
   * connection is cheap and the debug Chrome owns the actual browser).
   */
  browser: Browser;
  page: Page;
  profile: ProfileInfo;
  /** The browserContextId of the freshly-opened profile tab; null on lookup failure. */
  browserContextId: string | null;
  matchReason: RouteResult['matchReason'];
}

/**
 * One-call "give me a Playwright Page pinned to a Chrome profile" —
 * the safe replacement for `chromium.connectOverCDP(...).contexts()[0]`.
 *
 * The bare `connectOverCDP + contexts[0]` anti-pattern picks whichever
 * profile Playwright enumerates first, so in multi-profile debug Chrome
 * (the default ohwow setup once any secondary profile has been opened)
 * a caller can silently land in the Default profile's window — which on
 * most machines is unauthenticated. Then `page.goto('https://x.com/...')`
 * lands an unauthed tab on X. That was the live bug 2026-04-16.
 *
 * This helper fixes the class of bug at the source:
 *   1. Resolves a concrete profile from the hint (same chain
 *      deliverable-executor uses for x_posting_profile).
 *   2. Calls `ensureDebugChrome` + `openProfileWindow({url})` so the
 *      target URL is opened as a fresh tab in the correct
 *      browserContextId.
 *   3. Writes a `route`-source event to the chrome-profile-events
 *      ledger so `BrowserProfileGuardianExperiment` can detect future
 *      mismatches. Without this step the Guardian was blind to every
 *      bypass in synthesis-probe / acceptance / generated skills.
 *   4. Connects Playwright and uses `routeToProfile` (macOS window-
 *      title correlation) to hand back a Page in the right window.
 *
 * Callers that need a generated-skill-safe pattern should migrate from
 * `browser.contexts()[0]` to this helper. Use `debugPageProfileMap` to
 * confirm a given session has the expected mapping.
 */
export async function connectAndPinCdpPage(
  opts: ConnectAndPinOptions,
): Promise<ConnectAndPinResult> {
  const port = opts.port ?? DEFAULT_CDP_PORT;
  const timeoutMs = opts.timeoutMs ?? 10000;

  const profiles = listProfiles();
  if (profiles.length === 0) {
    throw new ChromeLifecycleError(
      'DEBUG_DIR_MISSING',
      'No profiles in debug Chrome dir. Run `ohwow chrome bootstrap` to populate it.',
    );
  }

  // Resolve target profile. Preference order matches
  // `deliverable-executor.ensureProfileChrome`:
  //   1. explicit `profile` arg (email / directory / local name)
  //   2. OHWOW_CHROME_PROFILE env (daemon-wide default)
  //   3. first profile with an email
  //   4. first profile overall
  const explicit = opts.profile ? findProfileByIdentity(profiles, opts.profile) : null;
  const envHint = process.env.OHWOW_CHROME_PROFILE;
  const envMatched = envHint ? findProfileByIdentity(profiles, envHint) : null;
  const target = explicit
    ?? envMatched
    ?? profiles.find((p) => !!p.email)
    ?? profiles[0];

  await ensureDebugChrome({ port, preferredProfile: target.directory });
  const opened = await openProfileWindow({
    profileDir: target.directory,
    port,
    url: opts.url,
    timeoutMs,
  });

  // Ledger event so the Guardian can see every explicit pin we perform.
  // `resolved_profile` is the same as `expected_profile` here because
  // `openProfileWindow` addresses a specific profile directory by name
  // — if it succeeded, Chrome opened the right window. The Guardian
  // still learns this helper was invoked, which bounds the ledger's
  // blind spot and gives `mismatch` detection a baseline.
  void appendChromeProfileEvent({
    source: 'route',
    port,
    pid: null,
    expected_profile: target.directory,
    resolved_profile: target.directory,
  });

  const pw = await import('playwright-core');
  const browser = await pw.chromium.connectOverCDP(`http://localhost:${port}`);

  try {
    const routed = await routeToProfile({
      browser,
      profile: target.email ?? target.directory,
      urlHint: opts.url,
      port,
      timeoutMs,
    });
    logger.debug(
      {
        profile: target.directory,
        ctx: opened.browserContextId?.slice(0, 8),
        matchReason: routed.matchReason,
      },
      '[chrome-profile-router] connectAndPinCdpPage resolved',
    );
    return {
      browser,
      page: routed.page,
      profile: routed.profile,
      browserContextId: opened.browserContextId,
      matchReason: routed.matchReason,
    };
  } catch (err) {
    // Close the Playwright Browser handle so we don't leak the CDP
    // connection on failure. The underlying debug Chrome stays up.
    await browser.close().catch(() => { /* ignore */ });
    throw err;
  }
}

/**
 * Find an existing page target whose URL host matches `hostMatch` (case-insensitive
 * substring). Returns null when none exist. Connects raw CDP briefly — the caller
 * doesn't hold a session open.
 *
 * Used by posting executors to reuse tabs the daemon (or the user) already has
 * open, instead of letting `openProfileWindow` always create a fresh one. Without
 * this the X and Threads posting cadences leak one tab per fire (48+/day each).
 */
export async function findExistingTabForHost(
  hostMatch: string,
  opts: { ownershipMode?: TabOwnershipMode; port?: number } = {},
): Promise<{ targetId: string; browserContextId: string | null } | null> {
  const { ownershipMode = 'any', port = DEFAULT_CDP_PORT } = opts;
  let browser: RawCdpBrowser | null = null;
  try {
    // spawnIfDown=false: this is a lookup, not an operation. If Chrome
    // is down we want to return null and let the caller decide whether
    // to spawn (they likely will, via their own ensureCdpBrowser call).
    browser = await ensureCdpBrowser({ port, spawnIfDown: false });
    const targets = await browser.getTargets();
    const needle = hostMatch.toLowerCase();
    // In 'ours' mode, only agent-owned tabs are candidates. A human who
    // opens x.com/home in the same debug Chrome is invisible here — their
    // targetId is never in the registry.
    const matches = targets.filter((t) =>
      t.type === 'page'
      && t.url.toLowerCase().includes(needle)
      && (ownershipMode === 'any' || isTabOwned(t.targetId)),
    );
    if (matches.length === 0) return null;
    const [match] = matches;
    return { targetId: match.targetId, browserContextId: match.browserContextId };
  } catch {
    return null;
  } finally {
    try { browser?.close(); } catch { /* ignore */ }
  }
}

/**
 * Close a specific CDP page target. Best-effort; swallows errors so callers
 * can use this in a `finally` block without risk. Used by posting executors
 * to drop the tab they opened via `openProfileWindow` so tabs don't leak.
 */
export async function closeTabById(
  targetId: string,
  port: number = DEFAULT_CDP_PORT,
): Promise<void> {
  releaseTabOwnership(targetId);
  let browser: RawCdpBrowser | null = null;
  try {
    browser = await ensureCdpBrowser({ port, spawnIfDown: false });
    await browser.closeTarget(targetId);
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, targetId: targetId.slice(0, 8) },
      '[chrome-profile-router] closeTabById best-effort failure',
    );
  } finally {
    try { browser?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// CDP connect helper — self-healing entry point for all browser automation.
// ---------------------------------------------------------------------------
//
// Every CDP consumer used to do this two-step ritual:
//
//   RawCdpBrowser.connect('http://localhost:9222', 5000)
//     -> fails with ECONNREFUSED if Chrome is down
//     -> caller has to catch + retry + call ensureDebugChrome
//
// When the operator closes Chrome (or it crashes), every scheduler
// tick, scan helper, and manual probe all fail until someone notices
// and spawns a fresh Chrome. That's not self-healing.
//
// ensureCdpBrowser wraps the sequence: probe, spawn-if-needed, connect.
// All compose/scan/reply paths now flow through this, so closing Chrome
// is a transient blip (next tick spawns a new one) rather than an
// outage that requires operator intervention.
//
// `spawnIfDown` defaults to true for normal callers. Pass false for
// best-effort cleanup paths (e.g., closing a tab during shutdown)
// where spawning a whole browser just to close one tab is overkill.

export interface EnsureCdpBrowserOptions {
  /** CDP port to probe + connect on. Defaults to DEFAULT_CDP_PORT (9222). */
  port?: number;
  /**
   * When the port isn't responding, spawn a debug Chrome first. Default
   * true — the common case for schedulers and compose helpers. Set false
   * for fire-and-forget cleanup where we'd rather fail fast than pay
   * the 5-10s browser-spawn cost.
   */
  spawnIfDown?: boolean;
}

/**
 * Acquire a RawCdpBrowser connected to the debug Chrome. Spawns one
 * first if Chrome isn't running (and spawnIfDown is not explicitly
 * false). Throws if spawn fails or the connect still times out —
 * callers should wrap in try/catch or finally for cleanup.
 */
export async function ensureCdpBrowser(
  opts: EnsureCdpBrowserOptions = {},
): Promise<RawCdpBrowser> {
  const { port = DEFAULT_CDP_PORT, spawnIfDown = true } = opts;
  if (spawnIfDown) {
    try {
      await ensureDebugChrome({ port });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, port },
        '[chrome-profile-router] ensureDebugChrome failed; CDP connect will retry anyway',
      );
    }
  }
  return RawCdpBrowser.connect(`http://localhost:${port}`, 5000);
}

// ---------------------------------------------------------------------------
// Tab ownership registry — Layer 1 of shared-browser cooperation.
// ---------------------------------------------------------------------------
//
// The human operator and the autonomous agents share the same debug Chrome
// at :9222. Without ownership tracking, agents' `findExistingTabForHost`
// calls return ANY matching tab — including ones the human is actively using
// — and the compose/scan/reply flow clobbers those tabs with a navigation.
//
// This registry is the first defense: when we create a tab for agent use,
// we add its targetId to `ownedTargets`. Tools that should never touch a
// human's tab call `findExistingTabForHost(host, { ownershipMode: 'ours' })`
// which filters to registry entries only. Tabs the human opened never enter
// the registry and are therefore invisible to ownership-gated lookups.
//
// Lifetime: in-memory, per-daemon-process. A daemon restart clears the
// registry — by design. After a restart, any pre-existing tab is treated
// as potentially the human's (safer); new tabs opened by the fresh
// daemon become ours from birth. The DOM-level marker (window.name set
// to 'ohwow-owned' by callers) survives restart and could be used to
// rehydrate the registry later, but we skip that for now: cheaper to
// just open fresh tabs and let orphans age out.

const ownedTargets = new Set<string>();

/** Mark a targetId as agent-owned. Call this right after creating a tab. */
export function markTabOwned(targetId: string): void {
  ownedTargets.add(targetId);
}

/** Drop ownership — call this before closing a tab or when releasing it back. */
export function releaseTabOwnership(targetId: string): void {
  ownedTargets.delete(targetId);
}

/** True if the targetId is in the registry (i.e., we created this tab). */
export function isTabOwned(targetId: string): boolean {
  return ownedTargets.has(targetId);
}

/** Snapshot of all owned target IDs. Useful for diagnostics + dashboards. */
export function listOwnedTargets(): string[] {
  return Array.from(ownedTargets);
}

/** How strict the tab search should be about ownership. */
export type TabOwnershipMode =
  /** Only consider tabs we created (safe: never touches human tabs). */
  | 'ours'
  /** Accept any matching tab, regardless of ownership (legacy, DM tools). */
  | 'any';

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
