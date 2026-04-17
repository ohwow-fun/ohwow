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

/** Result of acquiring a CDP page, with ownership tracking. */
export interface CdpPageHandle {
  page: RawCdpPage;
  /** True when this function created the tab (vs finding an existing one). */
  created: boolean;
}

/**
 * Acquire a RawCdpPage attached to a tab matching `urlMatcher` in the
 * profile pinned by `expectedContextId`. If no matching tab exists in
 * that context, opens a new one at `fallbackUrl`.
 *
 * When `expectedContextId` is absent, falls back to URL-only heuristic
 * (first tab whose URL matches). Returns null when nothing matches and
 * we can't safely create a tab.
 *
 * The caller is responsible for closing the page after use via
 * `page.close()` (detach + close WS) or `page.closeAndCleanup()`
 * (close tab + close WS, for tabs we created).
 */
export async function getCdpPageForPlatform(opts: {
  urlMatcher: (url: string) => boolean;
  fallbackUrl: string;
  expectedContextId?: string;
  logTag: string;
}): Promise<CdpPageHandle | null> {
  const { urlMatcher, fallbackUrl, expectedContextId, logTag } = opts;
  let browser: RawCdpBrowser | null = null;
  try {
    browser = await RawCdpBrowser.connect(CDP_URL, 5000);
    const targets = await browser.getTargets();
    const pageTargets = targets.filter((t) => t.type === 'page');
    if (pageTargets.length === 0) {
      logger.warn(`[${logTag}] CDP browser has no page targets`);
      browser.close();
      return null;
    }

    if (expectedContextId) {
      const inContext = pageTargets.filter((t) => t.browserContextId === expectedContextId);
      const target = inContext.find((t) => urlMatcher(t.url));

      if (!target) {
        try {
          const newTargetId = await browser.createTargetInContext(expectedContextId, fallbackUrl);
          logger.info(
            { ctx: expectedContextId.slice(0, 8), targetId: newTargetId.slice(0, 8) },
            `[${logTag}] opened new tab in target profile context`,
          );
          const page = await browser.attachToPage(newTargetId);
          await page.installUnloadEscapes();
          return { page, created: true };
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : err, ctx: expectedContextId.slice(0, 8) },
            `[${logTag}] createTargetInContext failed`,
          );
          browser.close();
          return null;
        }
      }

      logger.debug(
        { targetId: target.targetId.slice(0, 8), ctx: target.browserContextId?.slice(0, 8), url: target.url },
        `[${logTag}] attaching to existing tab in pinned profile context`,
      );
      const page = await browser.attachToPage(target.targetId);
      await page.installUnloadEscapes();
      return { page, created: false };
    }

    // Fallback: URL-only heuristic
    const target = pageTargets.find((t) => urlMatcher(t.url));
    if (!target) {
      logger.warn(
        { pageUrls: pageTargets.slice(0, 6).map((t) => t.url) },
        `[${logTag}] no matching tab in CDP; refusing to hijack an unrelated tab`,
      );
      browser.close();
      return null;
    }
    const page = await browser.attachToPage(target.targetId);
    await page.installUnloadEscapes();
    return { page, created: false };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, `[${logTag}] CDP connect failed`);
    if (browser) browser.close();
    return null;
  }
}

/**
 * Scoped CDP tab lifecycle: acquire a page, run the callback, then
 * clean up. If the tab was created by us, close it; if found, just
 * detach. The browser WebSocket is always closed.
 *
 * This is the preferred way to use CDP for operations that don't need
 * to persist the tab after completion (compose, read, post).
 */
export async function withCdpTab<T>(
  opts: {
    urlMatcher: (url: string) => boolean;
    fallbackUrl: string;
    expectedContextId?: string;
    logTag: string;
  },
  fn: (page: RawCdpPage) => Promise<T>,
): Promise<T | null> {
  const handle = await getCdpPageForPlatform(opts);
  if (!handle) return null;
  try {
    return await fn(handle.page);
  } finally {
    if (handle.created) {
      await handle.page.closeAndCleanup();
    } else {
      handle.page.close();
    }
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
 * Clear all text from a contenteditable / textbox. Uses the Selection
 * API to select all content, then a real Backspace key event to delete.
 * This fires React's input handlers correctly — `execCommand('delete')`
 * and `innerHTML = ''` bypass React's event system and leave the
 * component's internal state out of sync (verified on Threads 2026-04-16).
 */
export async function clearTextbox(page: RawCdpPage, selector: string): Promise<void> {
  try {
    const hasContent = await page.evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || !el.textContent?.trim()) return false;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString().length > 0;
    })()`);
    if (hasContent) {
      await page.pressKey('Backspace');
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Rich-text typing (DraftJS / ProseMirror / contenteditable)
// ---------------------------------------------------------------------------

/**
 * Type `text` into a rich-text editor (X DraftJS, Threads contenteditable,
 * etc.) using a cascading fallback of three strategies. Rich-text editors
 * reject different input methods depending on their framework + version;
 * any one strategy has proven to silently drop characters on at least
 * one surface we use. The cascade tries each in order until the DOM
 * reports >= 50% of the expected characters inside the target selector.
 *
 * Strategies, in order:
 *   1. CDP Input.insertText — the fastest; fires `input` events React
 *      state-syncs on. Works on Threads, X home-feed compose, X article.
 *   2. document.execCommand('insertText') — works on X reply composer
 *      per _x-harvest.mjs (the inline status-page reply composer uses
 *      a ProseMirror-derivative that strips Input.insertText but honors
 *      the execCommand path). Also recovers several Threads edge cases.
 *   3. CDP Input.dispatchKeyEvent per-character — the slowest; used as
 *      last resort. Was the primary strategy in 179ee75 but observed
 *      100% 0ch failure rate against X reply composer 2026-04-17.
 *
 * Before strategies: a warmup (typeText(' ') + Backspace) to kick the
 * editor's input pipeline into an accepting state — mirrors the Threads
 * reply path that publishes reliably. Strategy 1 is re-run AFTER the
 * warmup even though the warmup itself uses typeText under the hood,
 * because the warmup only sends a single space; the real text still
 * needs its own insertText call.
 *
 * Returns `{ok, strategy, observedLen}` so callers can log which path
 * won and surface the right failure message when all three fail.
 */
export interface TypeTextResult {
  ok: boolean;
  strategy: 'insertText' | 'execCommand' | 'dispatchKeyEvent' | 'none';
  observedLen: number;
  expectedLen: number;
}

export async function typeIntoRichTextbox(
  page: RawCdpPage,
  selector: string,
  text: string,
): Promise<TypeTextResult> {
  const expected = text.length;
  const minAccept = Math.max(5, Math.floor(expected * 0.5));

  async function measureLen(): Promise<number> {
    try {
      return await page.evaluate<number>(`(() => {
        const tb = document.querySelector(${JSON.stringify(selector)});
        return tb ? (tb.textContent || '').length : -1;
      })()`);
    } catch { return -1; }
  }

  async function clearAndFocus(): Promise<void> {
    try {
      await page.evaluate(`(() => {
        const tb = document.querySelector(${JSON.stringify(selector)});
        if (!(tb instanceof HTMLElement)) return false;
        tb.focus();
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
        return true;
      })()`);
    } catch { /* best effort */ }
    await wait(150);
  }

  // Warmup: seed the editor's input pipeline. Also re-establishes focus
  // on React-composer targets that lose keyboard routing across awaits.
  try {
    await page.typeText(' ');
    await page.pressKey('Backspace');
  } catch { /* best effort */ }
  await wait(100);

  // Strategy 1: CDP Input.insertText (single call, whole string).
  await clearAndFocus();
  try {
    await page.typeText(text);
  } catch { /* fall through */ }
  await wait(400);
  let observed = await measureLen();
  if (observed >= minAccept) {
    return { ok: true, strategy: 'insertText', observedLen: observed, expectedLen: expected };
  }

  // Strategy 2: document.execCommand('insertText'). Escape for JS string
  // literal embedding — backslashes first, then quotes + newlines.
  await clearAndFocus();
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
  try {
    await page.evaluate(`(() => {
      const tb = document.querySelector(${JSON.stringify(selector)});
      if (!(tb instanceof HTMLElement)) return false;
      tb.focus();
      return document.execCommand('insertText', false, '${escaped}');
    })()`);
  } catch { /* fall through */ }
  await wait(400);
  observed = await measureLen();
  if (observed >= minAccept) {
    return { ok: true, strategy: 'execCommand', observedLen: observed, expectedLen: expected };
  }

  // Strategy 3: CDP Input.dispatchKeyEvent per-character. Slowest, last
  // resort. Was the primary path historically but started failing with
  // 0ch against X's current reply composer.
  await clearAndFocus();
  const send = (page as unknown as { send: (m: string, p: unknown) => Promise<unknown> }).send.bind(page);
  for (const ch of text) {
    if (ch === '\n') {
      try { await page.pressKey('Enter'); } catch { /* continue */ }
      continue;
    }
    try {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
    } catch { /* continue */ }
  }
  await wait(500);
  observed = await measureLen();
  if (observed >= minAccept) {
    return { ok: true, strategy: 'dispatchKeyEvent', observedLen: observed, expectedLen: expected };
  }

  return { ok: false, strategy: 'none', observedLen: observed, expectedLen: expected };
}

// ---------------------------------------------------------------------------
// Post-publish confirmation (shared across X + Threads)
// ---------------------------------------------------------------------------

/**
 * Build a probe string suitable for confirming a just-published post
 * landed on the timeline/profile. Picks the first 6 whitespace-separated
 * tokens (capped at 60 chars) to stay resilient against X/Threads URL
 * shortening and inline-entity rendering — if the original text had
 * `https://long.example/path`, the rendered version might show
 * `long.example/...` instead, and a first-60-chars probe starting inside
 * the URL would miss. Words at the front of the content are almost
 * always preserved verbatim.
 *
 * Returns an empty string if the text has no usable leading tokens
 * (pure emoji/whitespace) — callers should treat an empty probe as
 * "can't confirm" and fall back to legacy modal-close detection.
 */
export function buildPostProbe(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const firstLine = trimmed.split('\n')[0];
  const words = firstLine.split(/\s+/).filter((w) => w.length > 0);
  const taken: string[] = [];
  let len = 0;
  for (const w of words) {
    if (taken.length >= 6) break;
    const add = (taken.length === 0 ? 0 : 1) + w.length;
    if (len + add > 60) break;
    taken.push(w);
    len += add;
  }
  return taken.join(' ');
}

/**
 * After a compose modal closes, positively confirm the post landed
 * by polling the DOM for our text within `timeoutMs`. This is the
 * missing half of "did the publish actually succeed" — modal-closed
 * alone is necessary but not sufficient (the dialog can close on
 * Cancel, Escape, connectivity glitches, or a silently-dismissed
 * error toast, with nothing published).
 *
 * Returns 'confirmed' when the probe text is visible in the page,
 * 'not_visible' when the polling window elapses without a match,
 * and 'probe_error' when we can't run the check (CDP hiccup). The
 * three-valued return lets callers distinguish "probably failed"
 * from "inconclusive" — only the former should flip the publish
 * result to success:false.
 */
export async function confirmPostLanded(
  page: RawCdpPage,
  text: string,
  timeoutMs: number = 2500,
): Promise<'confirmed' | 'not_visible' | 'probe_error'> {
  const probe = buildPostProbe(text);
  if (!probe) return 'probe_error';
  const escaped = probe.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const deadline = Date.now() + timeoutMs;
  let sawError = false;
  while (Date.now() < deadline) {
    try {
      const visible = await page.evaluate<boolean>(`(() => {
        const needle = "${escaped}";
        const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"], [data-pressable-container="true"], [role="article"]'));
        for (const a of articles) {
          const t = a.textContent || '';
          if (t.includes(needle)) return true;
        }
        const body = document.body?.innerText || '';
        return body.includes(needle);
      })()`);
      if (visible) return 'confirmed';
    } catch {
      sawError = true;
    }
    await wait(250);
  }
  return sawError ? 'probe_error' : 'not_visible';
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
