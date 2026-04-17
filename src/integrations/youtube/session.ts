/**
 * YouTube Studio session management.
 *
 * ensureYTStudio() guarantees: connected RawCdpBrowser + attached
 * RawCdpPage on studio.youtube.com in a known Chrome profile context,
 * with the welcome dialog dismissed and challenge detection run.
 *
 * Why raw CDP (not Playwright): see src/execution/browser/raw-cdp.ts.
 * Our upload + read flows need the `browserContextId` from CDP target
 * metadata to address a specific Chrome profile reliably — Playwright
 * collapses profiles into one BrowserContext and we can't tell them
 * apart without identity probes.
 *
 * Profile targeting strategy (ordered by specificity):
 *   1. Caller passes `browserContextId` → use that context directly.
 *   2. Caller passes `identity` (email/handle/directory) → find any
 *      existing page in a profile whose loaded YT/Google state matches,
 *      use its browserContextId.
 *   3. Fallback: any existing studio.youtube.com tab → attach.
 *   4. Last resort: any x.com tab's context → open Studio there.
 *
 * healthCheck(page) runs a single DOM eval that surfaces every signal
 * callers use to decide "is this session fit for work": logged-in flag,
 * channel id/handle, blocking dialogs, welcome prompt, cookie banner,
 * current URL. Read-only — never clicks, never navigates.
 */

import { RawCdpBrowser, type CdpTargetInfo, type RawCdpPage } from '../../execution/browser/raw-cdp.js';
import { logger } from '../../lib/logger.js';
import { detectChallenge, dismissWelcomeDialog, type YTChallenge } from './challenges.js';
import { YTLoginRequiredError, YTSessionError } from './errors.js';
import { SEL } from './selectors.js';

export const DEFAULT_CDP_PORT = 9222;
const STUDIO_URL = 'https://studio.youtube.com';

export interface EnsureYTStudioOptions {
  /** Existing RawCdpBrowser to reuse; otherwise we connect a fresh one. */
  browser?: RawCdpBrowser;
  /** CDP HTTP base — defaults to http://localhost:9222. */
  cdpHttpBase?: string;
  /** Pin a specific Chrome profile context. Takes precedence over identity. */
  browserContextId?: string;
  /**
   * Identity hint for verification. Checked *after* load — we don't use
   * it to pick a context (can't cheaply from raw CDP alone). If the
   * loaded channel handle/email doesn't match, we throw YTSessionError.
   * Accepts channel handle ("@foo"), channel id ("UCxxx…"), or email.
   */
  identity?: string;
  /** Max time to wait for Studio to load after navigation. */
  loadTimeoutMs?: number;
  /** Also run detectChallenge + throw if any challenge is present. Default true. */
  throwOnChallenge?: boolean;
}

export interface YTSession {
  browser: RawCdpBrowser;
  page: RawCdpPage;
  browserContextId: string | null;
  targetId: string;
  /** We own the browser WS — call close() when done. */
  ownsBrowser: boolean;
  health: YTHealth;
  challenge: YTChallenge | null;
}

export interface YTHealth {
  url: string;
  loggedIn: boolean;
  /** UC-prefixed channel ID if visible. */
  channelId: string | null;
  /** Handle with leading "@" if visible. Studio often doesn't expose this — will be null even when logged in. */
  channelHandle: string | null;
  /** Google session slot index ("0" = primary account). */
  sessionIndex: string | null;
  /** Unique identifier for the logged-in creator account. */
  datasyncId: string | null;
  /**
   * Policy flags surfaced by Studio bootstrap. When any are true the
   * creator has a pending copyright takedown / terms-of-use strike /
   * artist-roster issue that can block further uploads.
   */
  accountFlags: {
    hasUnacknowledgedCopyrightTakedown: boolean;
    hasUnacknowledgedTouStrike: boolean;
    hasArtistRoster: boolean;
  } | null;
  welcomeDialogOpen: boolean;
  consentBannerOpen: boolean;
  uploadDialogOpen: boolean;
  signInHref: string | null;
}

// ---------------------------------------------------------------------------
// Target finding
// ---------------------------------------------------------------------------

function pickStudioTarget(targets: CdpTargetInfo[], contextId?: string): CdpTargetInfo | null {
  const pages = targets.filter((t) => t.type === 'page');
  const studioPages = pages.filter((t) => /studio\.youtube\.com/.test(t.url));
  if (contextId) {
    const match = studioPages.find((t) => t.browserContextId === contextId);
    if (match) return match;
  }
  return studioPages[0] ?? null;
}

function pickFallbackContext(targets: CdpTargetInfo[]): { contextId: string | null; target: CdpTargetInfo | null } {
  const pages = targets.filter((t) => t.type === 'page');
  const yt = pages.find((t) => /youtube\.com/.test(t.url));
  if (yt?.browserContextId) return { contextId: yt.browserContextId, target: yt };
  const x = pages.find((t) => /https:\/\/(x|twitter)\.com/.test(t.url));
  if (x?.browserContextId) return { contextId: x.browserContextId, target: x };
  return { contextId: null, target: null };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export async function ensureYTStudio(opts: EnsureYTStudioOptions = {}): Promise<YTSession> {
  const ownsBrowser = !opts.browser;
  const browser = opts.browser ?? (await RawCdpBrowser.connect(opts.cdpHttpBase ?? `http://localhost:${DEFAULT_CDP_PORT}`, 5_000));
  const loadTimeoutMs = opts.loadTimeoutMs ?? 15_000;
  const throwOnChallenge = opts.throwOnChallenge ?? true;

  let targets = await browser.getTargets();
  let studio = pickStudioTarget(targets, opts.browserContextId);
  let usedContextId: string | null = opts.browserContextId ?? null;

  if (!studio) {
    // No Studio tab yet. Decide which context to open in.
    let openInContext = opts.browserContextId ?? null;
    if (!openInContext) {
      const fallback = pickFallbackContext(targets);
      openInContext = fallback.contextId;
    }
    if (openInContext) {
      const targetId = await browser.createTargetInContext(openInContext, STUDIO_URL);
      await waitForTargetUrl(browser, targetId, /studio\.youtube\.com/, loadTimeoutMs);
      targets = await browser.getTargets();
      studio = targets.find((t) => t.targetId === targetId) ?? null;
      usedContextId = openInContext;
    } else {
      // No context hint and no existing YT/X tab to piggyback on. Open
      // in no-context (Chrome picks default profile).
      const r = await browser.send<{ targetId: string }>('Target.createTarget', { url: STUDIO_URL });
      await waitForTargetUrl(browser, r.targetId, /studio\.youtube\.com/, loadTimeoutMs);
      targets = await browser.getTargets();
      studio = targets.find((t) => t.targetId === r.targetId) ?? null;
    }
  }

  if (!studio) {
    if (ownsBrowser) browser.close();
    throw new YTSessionError('could not open or find a YouTube Studio tab');
  }

  const page = await browser.attachToPage(studio.targetId);
  await page.installUnloadEscapes();

  // Ensure we're actually on Studio — it sometimes redirects through
  // accounts.google.com if the session is stale.
  const currentUrl = await page.url();
  if (!/studio\.youtube\.com/.test(currentUrl)) {
    await page.goto(STUDIO_URL);
  }

  // Dismiss welcome dialog if it's mounted.
  await dismissWelcomeDialog(page);

  // Gather state.
  const challenge = await detectChallenge(page);
  const health = await healthCheck(page);

  if (throwOnChallenge && challenge) {
    if (ownsBrowser) browser.close();
    throw new YTLoginRequiredError(
      `YouTube session unusable: ${challenge.detail}. ${challenge.remediation}`,
      { challenge },
    );
  }

  // Verify identity if caller passed one.
  if (opts.identity && health.loggedIn) {
    const match = identityMatches(opts.identity, health);
    if (!match) {
      logger.warn(
        { wanted: opts.identity, got: { channelId: health.channelId, handle: health.channelHandle } },
        '[youtube/session] identity mismatch',
      );
      if (ownsBrowser) browser.close();
      throw new YTSessionError(
        `identity mismatch: asked for "${opts.identity}" but Studio is signed in as ${health.channelHandle ?? health.channelId ?? 'unknown'}`,
        { wanted: opts.identity, got: health },
      );
    }
  }

  return {
    browser,
    page,
    browserContextId: studio.browserContextId ?? usedContextId,
    targetId: studio.targetId,
    ownsBrowser,
    health,
    challenge,
  };
}

/**
 * Read-only DOM probe. Single evaluate, no navigation, no clicks.
 * Returns a snapshot of the session's fitness. Fast (~one RTT).
 */
export async function healthCheck(page: RawCdpPage): Promise<YTHealth> {
  const result = await page.evaluate<YTHealth>(`(() => {
    const url = location.href;
    const welcomeDialogOpen = !!document.querySelector(${JSON.stringify(SEL.DIALOG_WELCOME_CLOSE)});
    const uploadDialogOpen = !!document.querySelector(${JSON.stringify(SEL.UPLOAD_DIALOG)});

    // Primary identity source: Studio bootstraps window.ytcfg.data_
    // with LOGGED_IN, CHANNEL_ID, SESSION_INDEX, DATASYNC_ID,
    // ACCOUNT_FLAGS. This is far more reliable than DOM probing.
    const cfg = (window && window.ytcfg && window.ytcfg.data_) || {};
    const cfgLoggedIn = cfg.LOGGED_IN === true;
    let channelId = cfg.CHANNEL_ID || null;
    const sessionIndex = cfg.SESSION_INDEX != null ? String(cfg.SESSION_INDEX) : null;
    const datasyncId = cfg.DATASYNC_ID || null;
    let accountFlags = null;
    if (cfg.ACCOUNT_FLAGS) {
      let af = cfg.ACCOUNT_FLAGS;
      if (typeof af === 'string') { try { af = JSON.parse(af); } catch { af = null; } }
      if (af && typeof af === 'object') {
        accountFlags = {
          hasUnacknowledgedCopyrightTakedown: !!af.has_unacknowledged_copyright_takedown,
          hasUnacknowledgedTouStrike: !!af.has_unacknowledged_tou_strike,
          hasArtistRoster: !!af.has_artist_roster,
        };
      }
    }

    // DOM-based fallbacks for URL-inferred state when ytcfg isn't populated
    // yet (e.g. mid-navigation).
    const signInForm = document.querySelector(${JSON.stringify(SEL.AUTH_SIGNIN_FORM)});
    const avatarBtn = document.querySelector(${JSON.stringify(SEL.CHANNEL_HEADER_AVATAR)});
    const onSignInUrl = /accounts\\.google\\.com/.test(url);
    const loggedIn = cfgLoggedIn || (!signInForm && !onSignInUrl && !!avatarBtn);

    if (!channelId) {
      const m = url.match(/\\/channel\\/(UC[\\w-]+)/);
      if (m) channelId = m[1];
    }
    if (!channelId) {
      const a = document.querySelector(${JSON.stringify(SEL.CHANNEL_HANDLE_ANCHOR)});
      const href = a ? a.getAttribute('href') : null;
      if (href) {
        const m2 = href.match(/\\/channel\\/(UC[\\w-]+)/);
        if (m2) channelId = m2[1];
      }
    }

    // Handle (optional): Studio rarely surfaces it. Check /@handle anchors as a best-effort.
    let channelHandle = null;
    const handleAnchors = document.querySelectorAll('a[href^="/@"], a[href*="youtube.com/@"]');
    for (const a of handleAnchors) {
      const h = a.getAttribute('href') || '';
      const hm = h.match(/\\/@([^/?#]+)/);
      if (hm) { channelHandle = '@' + hm[1]; break; }
    }

    const consentBannerOpen = !!document.querySelector(${JSON.stringify(SEL.CHALLENGE_CONSENT_AGREE)});
    const signInA = document.querySelector('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/signin"]');
    const signInHref = signInA ? signInA.getAttribute('href') : null;

    return {
      url, loggedIn, channelId, channelHandle,
      sessionIndex, datasyncId, accountFlags,
      welcomeDialogOpen, consentBannerOpen, uploadDialogOpen, signInHref,
    };
  })()`);
  return result;
}

function identityMatches(wanted: string, health: YTHealth): boolean {
  const w = wanted.trim().toLowerCase();
  if (!w) return true;
  if (health.channelId && health.channelId.toLowerCase() === w) return true;
  if (health.channelHandle && health.channelHandle.toLowerCase() === w) return true;
  if (health.channelHandle && '@' + w.replace(/^@/, '') === health.channelHandle.toLowerCase()) return true;
  // Email match: we don't read email from Studio DOM cheaply; ignore for now.
  // Callers that need email-level identity should use chrome-profile-router.
  return false;
}

async function waitForTargetUrl(
  browser: RawCdpBrowser,
  targetId: string,
  urlRegex: RegExp,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await browser.getTargets();
    const t = targets.find((x) => x.targetId === targetId);
    if (t && urlRegex.test(t.url)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new YTSessionError(`target ${targetId.slice(0, 8)} never reached ${urlRegex} within ${timeoutMs}ms`);
}
