/**
 * Shared CDP helpers for social media posting tools.
 *
 * Extracts common patterns from x-posting into reusable functions so
 * threads-posting (and future platforms) share the same battle-tested
 * CDP page acquisition, screenshot capture, modal dismissal, and
 * text-clearing logic.
 *
 * Design principles:
 *   - Platform-agnostic: no X.com or Threads selectors here
 *   - Thin wrappers around RawCdpPage primitives
 *   - Every helper that touches the browser is async + error-wrapped
 */

import { RawCdpBrowser, type RawCdpPage } from '../../execution/browser/raw-cdp.js';
import { logger } from '../../lib/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CDP_URL = 'http://localhost:9222';
export const HYDRATION_WAIT_MS = 2500;
export const POST_SETTLE_MS = 3000;

// ---------------------------------------------------------------------------
// CDP connection
// ---------------------------------------------------------------------------

/**
 * Acquire a RawCdpPage attached to a tab matching `urlMatcher` in the
 * profile pinned by `expectedContextId`. If no matching tab exists in
 * that context, opens a new one at `fallbackUrl`.
 *
 * When `expectedContextId` is absent, falls back to URL-only heuristic
 * (first tab whose URL matches). Returns null when nothing matches and
 * we can't safely create a tab.
 */
export async function getCdpPageForPlatform(opts: {
  urlMatcher: (url: string) => boolean;
  fallbackUrl: string;
  expectedContextId?: string;
  logTag: string;
}): Promise<RawCdpPage | null> {
  const { urlMatcher, fallbackUrl, expectedContextId, logTag } = opts;
  try {
    const browser = await RawCdpBrowser.connect(CDP_URL, 5000);
    const targets = await browser.getTargets();
    const pageTargets = targets.filter((t) => t.type === 'page');
    if (pageTargets.length === 0) {
      logger.warn(`[${logTag}] CDP browser has no page targets`);
      return null;
    }

    if (expectedContextId) {
      const inContext = pageTargets.filter((t) => t.browserContextId === expectedContextId);
      const target = inContext.find((t) => urlMatcher(t.url));

      if (!target) {
        // Open a new tab in the target profile context
        try {
          const newTargetId = await browser.createTargetInContext(expectedContextId, fallbackUrl);
          logger.info(
            { ctx: expectedContextId.slice(0, 8), targetId: newTargetId.slice(0, 8) },
            `[${logTag}] opened new tab in target profile context`,
          );
          const page = await browser.attachToPage(newTargetId);
          await page.installUnloadEscapes();
          return page;
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : err, ctx: expectedContextId.slice(0, 8) },
            `[${logTag}] createTargetInContext failed`,
          );
          return null;
        }
      }

      logger.debug(
        { targetId: target.targetId.slice(0, 8), ctx: target.browserContextId?.slice(0, 8), url: target.url },
        `[${logTag}] attaching to existing tab in pinned profile context`,
      );
      const page = await browser.attachToPage(target.targetId);
      await page.installUnloadEscapes();
      return page;
    }

    // Fallback: URL-only heuristic
    const target = pageTargets.find((t) => urlMatcher(t.url));
    if (!target) {
      logger.warn(
        { pageUrls: pageTargets.slice(0, 6).map((t) => t.url) },
        `[${logTag}] no matching tab in CDP; refusing to hijack an unrelated tab`,
      );
      return null;
    }
    const page = await browser.attachToPage(target.targetId);
    await page.installUnloadEscapes();
    return page;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, `[${logTag}] CDP connect failed`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JPEG screenshot (base64), quality 70. Returns undefined on failure. */
export async function captureScreenshot(page: RawCdpPage): Promise<string | undefined> {
  try {
    return await page.screenshotJpeg(70);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, '[social-cdp] screenshot failed');
    return undefined;
  }
}

/**
 * Focus an element by CSS selector via page.evaluate, then return true.
 * Scrolls the element into view before focusing.
 */
export async function focusBySelector(page: RawCdpPage, selector: string): Promise<boolean> {
  try {
    const ok = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLElement)) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return true;
    })()`);
    return ok === true;
  } catch {
    return false;
  }
}

/**
 * Focus an element by data-testid attribute.
 */
export async function focusByTestid(page: RawCdpPage, testid: string): Promise<boolean> {
  return focusBySelector(page, `[data-testid="${testid}"]`);
}

/**
 * Click the first element matching the given text content inside a
 * given scope. Dispatches a real mouse event via page.clickSelector so
 * React/framework onClick handlers fire.
 */
export async function clickByText(
  page: RawCdpPage,
  text: string,
  selectorScope = 'button, [role="button"], [role="menuitem"]',
): Promise<boolean> {
  try {
    const found = await page.evaluate(`(() => {
      const scope = ${JSON.stringify(selectorScope)};
      const target = ${JSON.stringify(text)};
      const nodes = Array.from(document.querySelectorAll(scope));
      for (const n of nodes) {
        const txt = (n.textContent || '').trim();
        if (txt === target || txt.startsWith(target)) {
          const el = n instanceof HTMLElement ? n : null;
          if (!el) continue;
          el.setAttribute('data-social-click-target', '1');
          return true;
        }
      }
      return false;
    })()`);
    if (!found) return false;
    const clicked = await page.clickSelector('[data-social-click-target="1"]', 5000);
    // Clean up marker
    await page.evaluate(`(() => {
      const el = document.querySelector('[data-social-click-target="1"]');
      if (el) el.removeAttribute('data-social-click-target');
      return true;
    })()`).catch(() => {});
    return clicked;
  } catch {
    return false;
  }
}

/**
 * Clear all text from a contenteditable / textbox by selecting all and
 * deleting. Useful before typing fresh content or before dismissing a
 * compose modal.
 */
export async function clearTextbox(page: RawCdpPage, selector: string): Promise<void> {
  await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el) { el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); }
    return true;
  })()`).catch(() => {});
}

// ---------------------------------------------------------------------------
// Compose result type (shared across platforms)
// ---------------------------------------------------------------------------

export interface ComposeResult {
  success: boolean;
  message: string;
  screenshotBase64?: string;
  postsTyped?: number;
  postsPublished?: number;
  currentUrl?: string;
  landedAt?: string;
  /** True when the platform blocked the post as duplicate content. */
  duplicateBlocked?: boolean;
}
