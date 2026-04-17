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

import { type RawCdpBrowser, type RawCdpPage } from '../../execution/browser/raw-cdp.js';
import {
  markTabOwned,
  isTabOwned,
  ensureCdpBrowser,
  type TabOwnershipMode,
} from '../../execution/browser/chrome-profile-router.js';
import { logger } from '../../lib/logger.js';

/**
 * Tag a tab as agent-owned at the DOM level. Sets window.name and
 * sessionStorage so even if the in-memory registry is lost (daemon
 * restart), the tab can be identified as ours on future inspection.
 * Best-effort; swallows errors.
 */
export async function tagTabAsOwned(page: RawCdpPage): Promise<void> {
  try {
    await page.evaluate(`(() => {
      try { window.name = 'ohwow-owned'; } catch {}
      try { sessionStorage.setItem('ohwow:owned', '1'); } catch {}
      return true;
    })()`);
  } catch { /* best effort */ }
}

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
  /**
   * Ownership gate: 'ours' filters reuse candidates to agent-owned tabs
   * only (tabs registered via markTabOwned). Defaults to 'any' to keep
   * existing callers working; compose/scan/reply paths should opt in
   * to 'ours' so they never touch a tab the human is actively using.
   */
  ownershipMode?: TabOwnershipMode;
}): Promise<CdpPageHandle | null> {
  const { urlMatcher, fallbackUrl, expectedContextId, logTag, ownershipMode = 'any' } = opts;
  // Tabs we create during this call are auto-added to the ownership
  // registry + DOM-tagged with window.name='ohwow-owned', so subsequent
  // 'ours' lookups recognize them.
  const isUsable = (targetId: string) => ownershipMode === 'any' || isTabOwned(targetId);
  let browser: RawCdpBrowser | null = null;
  try {
    // Self-heal: if the debug Chrome is down (operator quit it, crash,
    // etc.), ensureCdpBrowser spawns one before connecting. Adds ~50ms
    // when Chrome is already up (a port probe), ~5-10s when it needs
    // to be spawned. Without this, every scheduler tick fails with
    // ECONNREFUSED until the operator manually restarts Chrome.
    browser = await ensureCdpBrowser();
    const targets = await browser.getTargets();
    const pageTargets = targets.filter((t) => t.type === 'page');
    if (pageTargets.length === 0) {
      logger.warn(`[${logTag}] CDP browser has no page targets`);
      browser.close();
      return null;
    }

    if (expectedContextId) {
      const inContext = pageTargets.filter((t) => t.browserContextId === expectedContextId);
      const target = inContext.find((t) => urlMatcher(t.url) && isUsable(t.targetId));

      if (!target) {
        try {
          const newTargetId = await browser.createTargetInContext(expectedContextId, fallbackUrl);
          markTabOwned(newTargetId);
          logger.info(
            { ctx: expectedContextId.slice(0, 8), targetId: newTargetId.slice(0, 8), ownershipMode },
            `[${logTag}] opened new tab in target profile context`,
          );
          const page = await browser.attachToPage(newTargetId);
          await page.installUnloadEscapes();
          await tagTabAsOwned(page);
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
    const target = pageTargets.find((t) => urlMatcher(t.url) && isUsable(t.targetId));
    if (!target) {
      // Same reasoning as the pinned-context path: if we're in 'ours'
      // mode and have no owned tab matching the URL, open a fresh
      // owned one rather than bail. Lets scheduler/scan paths that
      // never thread expectedContextId still function after a daemon
      // restart cleared the ownership registry.
      //
      // Iterate over every unique browserContextId seen on existing
      // page targets rather than trusting the first one — a human
      // closing a Chrome window can leave stale targetInfo entries
      // whose context is gone, so picking the first context and
      // committing produces "Failed to find browser context with
      // id ..." errors. Retry with each unique context until one
      // sticks, then fall back to a context-less createTarget.
      if (ownershipMode === 'ours') {
        const uniqueCtxIds = [...new Set(pageTargets.map((t) => t.browserContextId).filter(Boolean) as string[])];
        let newTargetId: string | null = null;
        let lastErr: unknown = null;
        for (const ctx of uniqueCtxIds) {
          try {
            newTargetId = await browser.createTargetInContext(ctx, fallbackUrl);
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (!newTargetId) {
          // Final fallback: let Chrome pick its default context.
          try {
            newTargetId = await browser.createTargetDefault(fallbackUrl);
          } catch (err) {
            lastErr = err;
          }
        }
        if (newTargetId) {
          markTabOwned(newTargetId);
          logger.info(
            { targetId: newTargetId.slice(0, 8), ownershipMode, contextsTried: uniqueCtxIds.length },
            `[${logTag}] opened new owned tab (no-context fallback)`,
          );
          const page = await browser.attachToPage(newTargetId);
          await page.installUnloadEscapes();
          await tagTabAsOwned(page);
          return { page, created: true };
        }
        logger.warn(
          { err: lastErr instanceof Error ? lastErr.message : lastErr, contextsTried: uniqueCtxIds.length },
          `[${logTag}] createTarget fallback failed across all contexts`,
        );
      }
      logger.warn(
        { pageUrls: pageTargets.slice(0, 6).map((t) => t.url), ownershipMode },
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
  strategy: 'insertText' | 'execCommand' | 'dispatchKeyEvent' | 'paste' | 'none';
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

  // Focus without destructive clearing. On an empty DraftJS editor,
  // selectAll+delete or Backspace can remove the internal block node,
  // leaving the outer shell with nothing editable — which makes every
  // subsequent strategy fail at 0ch. Only clear if there's actually
  // content present, and never via Backspace-into-empty.
  async function focusOnly(): Promise<void> {
    try {
      await page.evaluate(`(() => {
        const tb = document.querySelector(${JSON.stringify(selector)});
        if (!(tb instanceof HTMLElement)) return false;
        tb.focus();
        return true;
      })()`);
    } catch { /* best effort */ }
    await wait(100);
  }

  async function focusAndClearIfDirty(): Promise<void> {
    try {
      await page.evaluate(`(() => {
        const tb = document.querySelector(${JSON.stringify(selector)});
        if (!(tb instanceof HTMLElement)) return false;
        tb.focus();
        if ((tb.textContent || '').trim().length > 0) {
          document.execCommand('selectAll', false);
          document.execCommand('delete', false);
        }
        return true;
      })()`);
    } catch { /* best effort */ }
    await wait(100);
  }

  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');

  // Strategy 1: CDP Input.dispatchKeyEvent per-character. Proven
  // live (2026-04-17) to both populate DraftJS content AND wake
  // EditorState on the X reply composer — the Post button's
  // disabled attribute flipped from "true" to null after this
  // strategy ran. Paste/execCommand populate the DOM but leave
  // EditorState stale, so the Post button stays disabled. Slower
  // than paste but it's the only strategy that both lands text and
  // unlocks submission in the current X release.
  await focusOnly();
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
  await wait(400);
  let observed = await measureLen();
  if (observed >= minAccept) {
    return { ok: true, strategy: 'dispatchKeyEvent', observedLen: observed, expectedLen: expected };
  }

  // Strategy 2: Clipboard paste. DraftJS ships with a dedicated
  // onPaste handler; when it fires, EditorState updates in one
  // step. Works on some X releases but not the current one (live
  // probe showed paste event dispatched but 0ch landed). Kept as a
  // defense-in-depth option for future X variants.
  await focusAndClearIfDirty();
  try {
    await page.evaluate(`(() => {
      const tb = document.querySelector(${JSON.stringify(selector)});
      if (!(tb instanceof HTMLElement)) return false;
      tb.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', '${escaped}');
      const ev = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      tb.dispatchEvent(ev);
      return true;
    })()`);
  } catch { /* fall through */ }
  await wait(400);
  observed = await measureLen();
  if (observed >= minAccept) {
    return { ok: true, strategy: 'paste', observedLen: observed, expectedLen: expected };
  }

  // Strategy 3: document.execCommand('insertText'). Populates DOM
  // reliably but doesn't wake DraftJS EditorState — the visible
  // text appears but the Post button stays disabled. Still useful
  // when the target composer is a plain contenteditable (Threads
  // in some states) rather than a full DraftJS/ProseMirror editor.
  await focusAndClearIfDirty();
  try {
    await page.evaluate(`(() => {
      const tb = document.querySelector(${JSON.stringify(selector)});
      if (!(tb instanceof HTMLElement)) return false;
      tb.focus();
      return document.execCommand('insertText', false, '${escaped}');
    })()`);
  } catch { /* fall through */ }
  await wait(300);
  observed = await measureLen();
  if (observed >= minAccept) {
    return { ok: true, strategy: 'execCommand', observedLen: observed, expectedLen: expected };
  }

  // Strategy 4: CDP Input.insertText (page.typeText). Canonical for
  // Threads + X top-level compose; last resort on X reply composer
  // since live probe shows it returning 0ch there.
  await focusOnly();
  try {
    await page.typeText(text);
  } catch { /* fall through */ }
  await wait(400);
  observed = await measureLen();
  if (observed >= minAccept) {
    return { ok: true, strategy: 'insertText', observedLen: observed, expectedLen: expected };
  }

  return { ok: false, strategy: 'none', observedLen: observed, expectedLen: expected };
}

// ---------------------------------------------------------------------------
// Submit-button selection (shared across X + Threads)
// ---------------------------------------------------------------------------

export interface SubmitClickSpec {
  /** data-testid values to consider, in priority order (optional). */
  testIds?: string[];
  /**
   * Exact textContent match for button-role elements (e.g., 'Post'). Used
   * for Threads' role=button divs that don't expose a testid. When
   * specified along with `containerSelector`, candidates are scoped to
   * inside that container.
   */
  textMatch?: string;
  /**
   * Scope selector (e.g., '[role="dialog"]') so textMatch-based lookups
   * don't accidentally match the left-nav "Post" composer launcher.
   */
  containerSelector?: string;
  /** How long to wait for a clickable button. Default 10000ms. */
  timeoutMs?: number;
  /** Poll interval. Default 500ms. */
  intervalMs?: number;
  /** Log tag for diagnostics. */
  logTag: string;
}

export interface SubmitClickResult {
  clicked: boolean;
  strategy?: 'testid' | 'textMatch';
  label?: string;
  /** On failure: snapshot of what we saw (for debugging). */
  diagnostic?: {
    candidates: number;
    disabled: number;
    hidden: number;
    lastUrl: string;
  };
}

/**
 * Wait for a submit button to be *enabled + visible*, then click it via
 * the element's synthetic .click() (not CDP coordinate clicks, which X
 * and Threads both overlay with transparent layers that eat the event).
 *
 * Why a dedicated primitive: every platform rotates their submit DOM —
 * X renders BOTH tweetButton and tweetButtonInline as siblings where one
 * is enabled and the other disabled; Threads wraps a "Post" text in 3
 * stacked divs where only one has the onClick handler; the text-search
 * approach `clickByText('Post')` picks the nav launcher instead of the
 * dialog's Post button if called without scope. A single polling helper
 * unifies the retry + enablement check + DOM-dispatch semantics so
 * caller code doesn't duplicate the logic in 4 places.
 *
 * Polling waits for `aria-disabled != "true"` AND `rect.width > 0` —
 * both must be true. clickSelector's coordinate click doesn't check
 * disabled state, so a stale aria-disabled=true button would silently
 * accept a "click" that X/Threads ignores internally.
 */
export async function clickFirstEnabledSubmit(
  page: RawCdpPage,
  spec: SubmitClickSpec,
): Promise<SubmitClickResult> {
  const {
    testIds = [],
    textMatch,
    containerSelector,
    timeoutMs = 10_000,
    intervalMs = 500,
    logTag,
  } = spec;

  // Build a JS-evaluated predicate that scans the DOM for candidates,
  // filters to enabled + visible, and clicks the first match via the
  // node's own .click() handler. Returns {clicked, strategy, label}
  // or null when nothing is clickable this cycle.
  const testIdsJson = JSON.stringify(testIds);
  const containerJson = JSON.stringify(containerSelector ?? '');
  const textMatchJson = JSON.stringify(textMatch ?? '');

  const attemptClick = `(() => {
    const testIds = ${testIdsJson};
    const textMatch = ${textMatchJson};
    const containerSel = ${containerJson};

    function isUsable(el) {
      if (!(el instanceof HTMLElement)) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      return true;
    }

    // testid candidates — first scan.
    for (const tid of testIds) {
      const nodes = Array.from(document.querySelectorAll('[data-testid="' + tid + '"]'));
      for (const n of nodes) {
        if (!isUsable(n)) continue;
        if (typeof n.click === 'function') { n.click(); return { clicked: true, strategy: 'testid', label: tid }; }
      }
    }

    // textMatch candidates — scoped to container if given.
    if (textMatch) {
      const root = containerSel ? document.querySelector(containerSel) : document;
      if (root) {
        const btns = Array.from(root.querySelectorAll(
          'button, [role="button"], div[role="button"]'
        ));
        for (const b of btns) {
          const txt = (b.textContent || '').trim();
          if (txt !== textMatch) continue;
          if (!isUsable(b)) continue;
          if (typeof b.click === 'function') { b.click(); return { clicked: true, strategy: 'textMatch', label: textMatch }; }
        }
      }
    }

    return null;
  })()`;

  const diagnosticQuery = `(() => {
    const testIds = ${testIdsJson};
    const textMatch = ${textMatchJson};
    const containerSel = ${containerJson};
    let candidates = 0;
    let disabled = 0;
    let hidden = 0;

    function tally(el) {
      candidates++;
      if (!(el instanceof HTMLElement)) return;
      if (el.getAttribute('aria-disabled') === 'true') disabled++;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) hidden++;
    }
    for (const tid of testIds) {
      for (const n of document.querySelectorAll('[data-testid="' + tid + '"]')) tally(n);
    }
    if (textMatch) {
      const root = containerSel ? document.querySelector(containerSel) : document;
      if (root) {
        for (const b of root.querySelectorAll('button, [role="button"], div[role="button"]')) {
          if ((b.textContent || '').trim() === textMatch) tally(b);
        }
      }
    }
    return { candidates, disabled, hidden, lastUrl: location.href };
  })()`;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await page.evaluate<{ clicked: true; strategy: 'testid' | 'textMatch'; label: string } | null>(
        attemptClick,
      );
      if (result?.clicked) {
        logger.debug(
          { strategy: result.strategy, label: result.label },
          `[${logTag}] submit clicked`,
        );
        return { clicked: true, strategy: result.strategy, label: result.label };
      }
    } catch { /* retry */ }
    await wait(intervalMs);
  }

  // Timed out — snapshot diagnostic for the caller's error message.
  let diag: SubmitClickResult['diagnostic'];
  try {
    diag = await page.evaluate<SubmitClickResult['diagnostic']>(diagnosticQuery);
  } catch { /* best effort */ }
  logger.warn(diag ?? {}, `[${logTag}] submit poll timed out`);
  return { clicked: false, diagnostic: diag };
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
