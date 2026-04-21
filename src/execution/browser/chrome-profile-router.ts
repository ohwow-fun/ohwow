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
import { RawCdpBrowser, type RawCdpPage } from './raw-cdp.js';
import {
  claimTarget,
  currentOwner,
  hasAnyClaimForTarget,
  releaseByTargetId,
  releaseTarget,
  type ClaimHandle,
} from './browser-claims.js';
import { withProfileLock } from './profile-mutex.js';
import { insertCdpTraceEvent } from './cdp-trace-store.js';

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

  // Serialize per-profile so two concurrent synthesis-probe /
  // connectAndPinCdpPage calls on the same profile don't both
  // `openProfileWindow` (which would create duplicate fresh windows).
  // Different profiles still run in parallel.
  return withProfileLock(target.directory, async () => {
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
  });
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
      && (ownershipMode === 'any' || hasAnyClaimForTarget(t.targetId)),
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
 * Navigate a CDP page to `url` (default `about:blank`) to flush prior
 * per-tab state (scroll position, selection, modals, half-typed
 * compose drafts) before we reuse it for a new task.
 *
 * Already-at-url → no-op. Same-URL `Page.navigate` would force a full
 * reload that costs 1-2s on x.com and throws off identity probes that
 * read the sidebar immediately after; skipping it keeps reuse cheap.
 *
 * Best-effort: errors are swallowed. A page that refuses to navigate
 * is still reusable — the composer's own navigation will decide
 * whether to recover or bail.
 */
export async function resetTab(page: RawCdpPage, url: string = 'about:blank'): Promise<void> {
  try {
    const current = await page.url();
    // Normalize trailing-slash edge: 'https://x.com/home' and
    // 'https://x.com/home/' are equivalent to humans but not to CDP.
    const normalize = (u: string): string => u.replace(/\/+$/, '');
    if (normalize(current) === normalize(url)) return;
    await page.goto(url);
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, targetUrl: url },
      '[chrome-profile-router] resetTab best-effort failure',
    );
  }
}

/**
 * Two-pass reusable-tab lookup that plays nice with the task-scoped
 * claims model:
 *
 *   1. Iterate page targets whose URL host matches `hostMatch`, AND
 *      (when `expectedBrowserContextId` is supplied) whose CDP
 *      `browserContextId` equals it, AND (when `ownershipMode === 'ours'`)
 *      that are already agent-owned via `hasAnyClaimForTarget`.
 *   2. For each match, check `currentOwner({profileDir, targetId})`.
 *      An UNOWNED tab is reusable under `'any'` (legacy default) but
 *      not under `'ours'` — `'ours'` rejects anything with no live
 *      claim, so a human's Threads tab can't be hijacked.
 *   3. On successful claim, attach a `RawCdpPage` and (optionally)
 *      `resetTab(page, resetUrl)` to flush prior state. Return the
 *      handle so the caller can release + close it at task end.
 *
 * Claim-race: `currentOwner` -> `claimTarget` is NOT atomic against
 * other callers reading between the two. If someone wins first,
 * `claimTarget` returns null; we log WARN and keep scanning — the
 * caller falls through to "open fresh" on null return.
 *
 * `profileDir` must match the profile the caller is working in, so
 * claim namespacing is consistent with openProfileWindow-initiated
 * claims. `hostMatch` is a case-insensitive substring (same semantics
 * as `findExistingTabForHost`).
 */
export interface ReusableTabHandle {
  page: RawCdpPage;
  targetId: string;
  browserContextId: string | null;
  claim: ClaimHandle;
  /** Close the CDP browser WS when caller is done. (The tab itself stays open for the next reuse.) */
  closeBrowser: () => void;
}

export async function findReusableTabForHost(opts: {
  hostMatch: string;
  profileDir: string;
  owner: string;
  /** URL to navigate the reused tab to via resetTab. Default 'about:blank'. Pass the host landing page (e.g. x.com/home) to land ready-to-compose. */
  resetUrl?: string;
  /**
   * Ownership gate. Default 'any' preserves the pre-existing cross-tick
   * reuse pattern (executor releases its task-scoped claim at task end
   * and relies on URL+profile match to pick the tab back up). Callers
   * that want strict hijack-proof semantics AND manage a persistent
   * claim layer can opt in to 'ours'.
   */
  ownershipMode?: TabOwnershipMode;
  /**
   * Require matched tabs to live in this Chrome browser context. Pins
   * the lookup to a specific profile so a human's threads.com tab in
   * another profile can't be grabbed. Undefined = don't filter by
   * context (legacy behavior).
   */
  expectedBrowserContextId?: string;
  port?: number;
}): Promise<ReusableTabHandle | null> {
  const {
    hostMatch,
    profileDir,
    owner,
    resetUrl,
    ownershipMode = 'any',
    expectedBrowserContextId,
    port = DEFAULT_CDP_PORT,
  } = opts;
  let browser: RawCdpBrowser | null = null;
  try {
    // spawnIfDown=false mirrors findExistingTabForHost — if Chrome is
    // gone the caller will handle it via their own ensureDebugChrome.
    browser = await ensureCdpBrowser({ port, spawnIfDown: false });
    const targets = await browser.getTargets();
    const needle = hostMatch.toLowerCase();
    const matches = targets.filter((t) =>
      t.type === 'page'
      && t.url.toLowerCase().includes(needle)
      && (expectedBrowserContextId === undefined || t.browserContextId === expectedBrowserContextId)
      && (ownershipMode === 'any' || hasAnyClaimForTarget(t.targetId)),
    );
    for (const match of matches) {
      const existingOwner = currentOwner({ profileDir, targetId: match.targetId });
      if (existingOwner && existingOwner !== owner) continue; // Held by a concurrent task.

      const claim = claimTarget({ profileDir, targetId: match.targetId }, owner);
      if (!claim) {
        // Race: someone else claimed between our currentOwner read and
        // our claimTarget write. Warn + keep scanning.
        logger.warn(
          { targetId: match.targetId.slice(0, 8), profileDir, owner },
          '[chrome-profile-router] tab-reuse race: claim taken between check + set; trying next match',
        );
        continue;
      }

      let page: RawCdpPage;
      try {
        page = await browser.attachToPage(match.targetId);
        await page.installUnloadEscapes();
      } catch (err) {
        // Attach failed (tab died mid-scan?) — drop the claim so
        // releaseAllForOwner at task end doesn't leave a stale entry
        // and keep scanning.
        claim.release();
        logger.debug(
          { err: err instanceof Error ? err.message : err, targetId: match.targetId.slice(0, 8) },
          '[chrome-profile-router] attachToPage failed during reuse',
        );
        continue;
      }

      if (resetUrl) {
        await resetTab(page, resetUrl);
      }

      logger.info(
        { cdp: true, action: 'reuse:hit', profile: profileDir, contextId: match.browserContextId, targetId: match.targetId, owner, url: match.url },
        '[chrome-profile-router] reusing existing tab',
      );
      insertCdpTraceEvent({ action: 'reuse:hit', profile: profileDir, targetId: match.targetId, owner, url: match.url, contextId: match.browserContextId });
      const closeBrowser = (): void => {
        try { browser?.close(); } catch { /* ignore */ }
      };
      // Don't close the browser WS in the finally below — the caller
      // now owns it via `closeBrowser`.
      const handle: ReusableTabHandle = {
        page,
        targetId: match.targetId,
        browserContextId: match.browserContextId,
        claim,
        closeBrowser,
      };
      browser = null; // Ownership transferred.
      return handle;
    }
    return null;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, hostMatch },
      '[chrome-profile-router] findReusableTabForHost unexpected error',
    );
    return null;
  } finally {
    try { browser?.close(); } catch { /* ignore */ }
  }
}

/**
 * Close a specific CDP page target. Best-effort; swallows errors so callers
 * can use this in a `finally` block without risk. Used by posting executors
 * to drop the tab they opened via `openProfileWindow` so tabs don't leak.
 *
 * Any claim on the targetId is also released so a future task re-attaching
 * at the same id doesn't see a stale claim.
 */
export async function closeTabById(
  targetId: string,
  port: number = DEFAULT_CDP_PORT,
): Promise<void> {
  // Release any claim for this target regardless of owner — the tab is
  // about to disappear, so keeping the claim around is meaningless.
  logger.debug({ cdp: true, action: 'tab:close', targetId }, '[chrome-profile-router] closing tab');
  insertCdpTraceEvent({ action: 'tab:close', targetId });
  releaseTarget(targetId);
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
 *
 * Every successful connect is decorated with a `Target.targetDestroyed`
 * subscription (idempotent per RawCdpBrowser instance) so claims on
 * externally-closed tabs get released automatically. See
 * `ensureTargetDestroyedSubscription` below.
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
  const browser = await RawCdpBrowser.connect(`http://localhost:${port}`, 5000);
  // Fire-and-forget: `Target.setDiscoverTargets` needs to be enabled
  // before destroyed events flow, and we only want to do it once per
  // connection. The helper is internally idempotent via the WeakSet.
  ensureTargetDestroyedSubscription(browser).catch((err) => {
    logger.debug(
      { err: err instanceof Error ? err.message : err },
      '[chrome-profile-router] ensureTargetDestroyedSubscription failed (non-fatal)',
    );
  });
  return browser;
}

// ---------------------------------------------------------------------------
// Target.targetDestroyed → automatic claim release.
// ---------------------------------------------------------------------------
//
// When the human operator closes an agent-owned tab by hand (or the
// tab crashes, or its renderer dies), the owning task can't know — it
// keeps the claim alive until `releaseAllForOwner` runs at task end.
// During that window, `findReusableTabForHost` sees the stale claim,
// skips the (now-dead) target, and opens a brand-new tab. Over a long
// session those orphan claims accumulate and every reuse path degrades
// to "just open a new tab."
//
// The fix: subscribe to CDP's browser-level `Target.targetDestroyed`
// event. Whenever Chrome tells us a target is gone, call
// `releaseByTargetId` to evict any claim that still references it.
//
// CDP gotcha: `Target.targetDestroyed` only fires after
// `Target.setDiscoverTargets({discover: true})` is called on the
// browser session. Without that call, the browser never sends these
// events to our WebSocket at all. Nothing else in the repo enables
// discovery, so we do it here.

const subscribedBrowsers = new WeakSet<RawCdpBrowser>();

/**
 * Ensure the given browser is subscribed to `Target.targetDestroyed`
 * so claims get auto-released when a tab disappears. Idempotent: every
 * browser is tracked in a module-level WeakSet, so repeated calls on
 * the same instance are no-ops.
 *
 * Safe to call fire-and-forget — any internal CDP error is logged at
 * debug level rather than rethrown; the subscription is a nice-to-
 * have, not a correctness requirement for the calling path.
 *
 * Exported for testing. Production callers should just let
 * `ensureCdpBrowser` invoke it automatically.
 */
export async function ensureTargetDestroyedSubscription(
  browser: RawCdpBrowser,
): Promise<void> {
  if (subscribedBrowsers.has(browser)) return;
  subscribedBrowsers.add(browser);

  // Register the listener BEFORE enabling discovery so we don't miss
  // the first event that might fire in response to setDiscoverTargets'
  // initial "targetCreated" burst. (targetDestroyed won't fire there,
  // but ordering the calls this way is harmless and avoids any
  // theoretical race.)
  browser.on('Target.targetDestroyed', (params) => {
    const p = params as { targetId?: unknown } | null | undefined;
    const targetId = p && typeof p.targetId === 'string' ? p.targetId : null;
    if (!targetId) return;
    const released = releaseByTargetId(targetId);
    if (released > 0) {
      logger.info(
        { cdp: true, action: 'tab:destroyed', targetId: targetId.slice(0, 8), released },
        '[chrome-profile-router] tab destroyed externally; released claim(s)',
      );
      insertCdpTraceEvent({ action: 'tab:destroyed', targetId: targetId.slice(0, 8), released });
    }
    // released === 0 is the normal case (human closed a non-agent tab).
    // Intentionally silent to keep log volume sane.
  });

  try {
    await browser.send('Target.setDiscoverTargets', { discover: true });
  } catch (err) {
    // Re-enable allowed: if Chrome already has discovery on from a
    // prior connection on this WS (shouldn't happen since we connect
    // fresh each time, but be defensive), it returns success anyway.
    // Real failures we log + swallow — the subscription still exists;
    // we just may not receive events until discovery is re-enabled
    // elsewhere.
    logger.debug(
      { err: err instanceof Error ? err.message : err },
      '[chrome-profile-router] Target.setDiscoverTargets failed',
    );
  }
}

// ---------------------------------------------------------------------------
// Tab ownership — Layer 1 of shared-browser cooperation.
// ---------------------------------------------------------------------------
//
// The human operator and the autonomous agents share the same debug Chrome
// at :9222. Without ownership tracking, agents' `findExistingTabForHost`
// calls return ANY matching tab — including ones the human is actively
// using — and the compose/scan/reply flow clobbers those tabs with a
// navigation.
//
// Ownership lives in `browser-claims.ts` now: a task-scoped, atomic
// registry keyed by `{profileDir, targetId}` → owner (typically a task
// id). The old process-wide Set<string> couldn't distinguish between
// two concurrent tasks racing on the same target; claims fix that.
//
// Router-internal checks only need the "is this tab agent-owned at all?"
// semantics that the old Set encoded. They use `hasAnyClaimForTarget`
// from browser-claims for that. The per-task claim/release lives at the
// executor layer (x-posting-executor, threads-posting-executor).
//
// Lifetime: in-memory, per-daemon-process. A daemon restart clears
// claims — by design; restart implies no in-flight tasks. The DOM-level
// marker (window.name='ohwow-owned' set by callers) survives restart
// and could rehydrate claims lazily later.

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
  resolveBrowserContextForProfile,
} from './chrome-lifecycle.js';
export type { ProfileInfo, DebugChromeHandle } from './chrome-lifecycle.js';
