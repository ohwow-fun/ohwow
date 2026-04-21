/**
 * Minimal raw CDP driver that talks directly to a running Chrome's
 * WebSocket debugger. Used by the X posting path because Playwright's
 * `chromium.connectOverCDP()` reproducibly hangs for 30s on ohwow's
 * multi-profile debug Chrome setup — the same Chrome responds to raw
 * CDP calls in milliseconds (`Target.getTargets`, `Browser.getVersion`,
 * `Target.attachToTarget`). See scripts/verify-x-post.md for the
 * matrix of "Playwright fails / raw CDP works" repros.
 *
 * The driver is deliberately small — just what composeTweetViaBrowser
 * and related flows need:
 *   - find page targets (grouped by browserContextId, i.e. profile)
 *   - attach to one via `Target.attachToTarget` (flatten = true)
 *   - navigate, type, click, screenshot, evaluate
 *
 * Design:
 *   - One `RawCdpBrowser` wraps the browser-level WebSocket.
 *   - `RawCdpPage` wraps a single page's session (sessionId).
 *   - Everything goes over the same browser-level WS — we use
 *     `sessionId` on outbound frames so the browser routes them to the
 *     right target. This matches how Playwright does it internally, but
 *     cuts out the stuff that's making connectOverCDP hang.
 *
 * Why not use Playwright at all? Because:
 *   - Playwright collapses all Chrome profiles into one BrowserContext,
 *     so we can't address profiles by context — we have to probe pages
 *     and guess. Raw CDP exposes `browserContextId` per target, which
 *     IS the profile identifier we need.
 *   - The 30s hang is a dealbreaker for any UX — every tweet attempt
 *     would stall the agent for half a minute before falling through.
 */

import WebSocket from 'ws';
import { logger } from '../../lib/logger.js';
import { insertCdpTraceEvent } from './cdp-trace-store.js';

export interface CdpTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  browserContextId: string | null;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * Connection to a browser-level CDP endpoint. One instance drives many
 * page sessions — we route per-session by including `sessionId` on
 * outbound frames.
 */
export class RawCdpBrowser {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private eventListeners = new Map<string, Array<(params: unknown, sessionId?: string) => void>>();
  private closed = false;

  private wsUrl: string;
  private constructor(wsUrl: string) { this.wsUrl = wsUrl; }

  static async connect(cdpHttpBase = 'http://localhost:9222', timeoutMs = 5000): Promise<RawCdpBrowser> {
    const versionUrl = `${cdpHttpBase}/json/version`;
    const v = await fetch(versionUrl).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>);
    const browser = new RawCdpBrowser(v.webSocketDebuggerUrl);
    await browser.openWs(timeoutMs);
    return browser;
  }

  private openWs(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        reject(new Error(`raw CDP connect timeout after ${timeoutMs}ms`));
        try { this.ws?.close(); } catch { /* ignore */ }
      }, timeoutMs);
      this.ws.once('open', () => { clearTimeout(timer); resolve(); });
      this.ws.once('error', (err: Error) => { clearTimeout(timer); reject(err); });
      this.ws.on('message', (data: Buffer) => this.onMessage(data));
      this.ws.on('close', () => { this.closed = true; });
    });
  }

  private onMessage(data: Buffer): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id as number);
      if (pending) {
        this.pending.delete(msg.id as number);
        if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const listeners = this.eventListeners.get(msg.method as string);
      if (listeners) {
        for (const l of listeners) {
          try { l(msg.params, msg.sessionId as string | undefined); } catch { /* ignore */ }
        }
      }
    }
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) throw new Error('CDP connection closed');
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('CDP websocket not open');
    const id = ++this.nextId;
    const frame: Record<string, unknown> = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void {
    if (!this.eventListeners.has(method)) this.eventListeners.set(method, []);
    const list = this.eventListeners.get(method)!;
    list.push(handler);
    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  async getTargets(): Promise<CdpTargetInfo[]> {
    const r = await this.send<{ targetInfos: Array<{ targetId: string; type: string; title: string; url: string; browserContextId?: string }> }>('Target.getTargets');
    return r.targetInfos.map((t) => ({
      targetId: t.targetId,
      type: t.type,
      title: t.title,
      url: t.url,
      browserContextId: t.browserContextId ?? null,
    }));
  }

  async attachToPage(targetId: string): Promise<RawCdpPage> {
    logger.debug({ cdp: true, action: 'tab:attach', targetId }, '[raw-cdp] attaching to page');
    insertCdpTraceEvent({ action: 'tab:attach', targetId });
    const r = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new RawCdpPage(this, r.sessionId, targetId);
    // Enable the subset of domains this driver needs.
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // Auto-accept native beforeunload / confirm / alert dialogs. Without
    // this Chrome pops its "Leave site? Changes you made may not be saved"
    // modal when we navigate away from x.com/compose/post with pending
    // content, freezing every subsequent CDP interaction with that target
    // until a human clicks a button. Accept every dialog — we've already
    // committed to the action upstream.
    this.on('Page.javascriptDialogOpening', (_params, sid) => {
      if (sid !== r.sessionId) return;
      this.send('Page.handleJavaScriptDialog', { accept: true }, r.sessionId).catch(() => { /* best-effort */ });
    });
    return page;
  }

  async createTargetInContext(browserContextId: string, url = 'about:blank'): Promise<string> {
    const r = await this.send<{ targetId: string }>('Target.createTarget', { url, browserContextId });
    return r.targetId;
  }

  /**
   * Create a tab without pinning it to a specific browserContextId —
   * Chrome uses the default context. Used as a last-resort fallback
   * when a caller tried one or more specific contexts and they all
   * failed (e.g., the context ID was cached from a now-closed
   * window).
   */
  async createTargetDefault(url = 'about:blank'): Promise<string> {
    const r = await this.send<{ targetId: string }>('Target.createTarget', { url });
    return r.targetId;
  }

  /**
   * Close a browser tab/target by its targetId. The tab disappears from
   * Chrome and any sessions attached to it become invalid. Best-effort:
   * swallows errors so callers can fire-and-forget in finally blocks.
   */
  async closeTarget(targetId: string): Promise<void> {
    try {
      await this.send('Target.closeTarget', { targetId });
    } catch {
      /* best effort — target may already be closed */
    }
  }

  close(): void {
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

/**
 * One page session. All methods take the browser's WS and route by
 * sessionId. Matches the minimal surface x-posting needs (goto, type,
 * click, screenshot, evaluate, url/title).
 */
export class RawCdpPage {
  private browser: RawCdpBrowser;
  private sessionId: string;
  public readonly targetId: string;
  constructor(browser: RawCdpBrowser, sessionId: string, targetId: string) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  /**
   * Wait for the next occurrence of a named CDP event scoped to this
   * page's session. Resolves with the event params. Rejects on timeout.
   * Used for FileChooser interception and similar one-shot signals.
   */
  async waitForEvent<T = unknown>(method: string, timeoutMs = 5_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const to = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.browser.on(method, (params, sid) => {
        if (sid && sid !== this.sessionId) return;
        clearTimeout(to);
        off();
        resolve(params as T);
      });
    });
  }

  async goto(url: string): Promise<void> {
    logger.debug({ cdp: true, action: 'navigate', targetId: this.targetId, url }, '[raw-cdp] navigating');
    insertCdpTraceEvent({ action: 'navigate', targetId: this.targetId, url });
    await this.send('Page.navigate', { url });
    await this.waitForLoad();
  }

  /**
   * Wait for the current navigation's `load` event. Uses
   * `Page.lifecycleEvent` because `Page.frameStoppedLoading` isn't
   * fired on same-document navigations (pushState) and we may want to
   * cover both. 10s ceiling — X compose loads in 1-2s normally.
   */
  private async waitForLoad(timeoutMs = 10000): Promise<void> {
    await new Promise<void>((resolve) => {
      const to = setTimeout(() => { off(); resolve(); }, timeoutMs);
      const off = this.browser.on('Page.loadEventFired', (_p, sid) => {
        if (sid && sid !== this.sessionId) return;
        clearTimeout(to); off(); resolve();
      });
    });
  }

  url(): Promise<string> {
    return this.evaluate<string>('window.location.href');
  }

  title(): Promise<string> {
    return this.evaluate<string>('document.title');
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T; description?: string; type: string } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result.value as T;
  }

  /**
   * Focus the element matched by `expression` (a JS expression that
   * resolves to an element, e.g. 'document.querySelector("...")') and
   * return true if found + focused. The one-expression form sidesteps
   * Runtime.callFunctionOn object-id juggling.
   */
  async focus(expression: string): Promise<boolean> {
    return this.evaluate<boolean>(`(() => { const el = ${expression}; if (!el) return false; el.focus(); return document.activeElement === el; })()`);
  }

  /**
   * Type `text` into whatever has focus. Verified against X's
   * ProseMirror composer: a single `Input.insertText` call with the
   * full string populates the editor and fires the React input events
   * (Post button lights up). The per-char loop we started with either
   * raced the editor or got dropped silently on some runs, so we
   * collapse to one call and split only on '\n' to preserve line breaks.
   */
  async typeText(text: string): Promise<void> {
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].length > 0) {
        await this.send('Input.insertText', { text: parts[i] });
      }
      if (i < parts.length - 1) {
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      }
    }
  }

  /**
   * Click the first element matching the given CSS selector, using a
   * real mouse event so React onClick handlers fire. Returns false when
   * the selector matches nothing or the element has no rect.
   */
  async clickSelector(selector: string, timeoutMs = 10000): Promise<boolean> {
    const rect = await this.waitForSelectorRect(selector, timeoutMs);
    if (!rect) return false;
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  }

  private async waitForSelectorRect(
    selector: string,
    timeoutMs: number,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rect = await this.evaluate<{ x: number; y: number; width: number; height: number } | null>(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return null; return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
      );
      if (rect) return rect;
      await sleep(150);
    }
    return null;
  }

  async screenshotPng(): Promise<string> {
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return r.data;
  }

  /**
   * JPEG screenshot (base64). Used by x-posting to keep tool-result
   * payloads small — JPEG quality 70 is ~5-10× smaller than PNG for
   * the same X compose UI and fits inside orchestrator screenshot
   * budgets comfortably.
   */
  async screenshotJpeg(quality = 70): Promise<string> {
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality });
    return r.data;
  }

  /**
   * Dispatch a single key press (keydown + keyup) against whatever has
   * focus. Matches Playwright's `page.keyboard.press(key)` surface.
   * Handles the common keys x-posting uses (Backspace, Enter, Tab); for
   * full fidelity fall back to page.send('Input.dispatchKeyEvent').
   */
  async pressKey(key: string): Promise<void> {
    const codeMap: Record<string, { code: string; keyCode: number }> = {
      Backspace: { code: 'Backspace', keyCode: 8 },
      Enter: { code: 'Enter', keyCode: 13 },
      Tab: { code: 'Tab', keyCode: 9 },
      Escape: { code: 'Escape', keyCode: 27 },
    };
    const m = codeMap[key] ?? { code: key, keyCode: 0 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: m.code, windowsVirtualKeyCode: m.keyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: m.code, windowsVirtualKeyCode: m.keyCode });
  }

  /**
   * Poll until a selector matches at least one element in the document.
   * Mirrors Playwright's `page.waitForSelector(sel, { state: 'attached' })`
   * — existence is enough, visibility is not required. Used by DM +
   * article flows where the dialog/composer mounts asynchronously.
   * Returns true when found before timeout, false otherwise.
   */
  async waitForSelector(selector: string, timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const present = await this.evaluate<boolean>(
        `(() => !!document.querySelector(${JSON.stringify(selector)}))()`,
      );
      if (present) return true;
      await sleep(150);
    }
    return false;
  }

  /**
   * Suppress beforeunload / dialog popups so navigations away from
   * compose don't freeze the whole flow. Mirrors what getCdpPage used
   * to install in the Playwright driver.
   */
  async installUnloadEscapes(): Promise<void> {
    await this.evaluate<boolean>(`(() => {
      try {
        window.onbeforeunload = null;
        window.addEventListener('beforeunload', (e) => {
          e.stopImmediatePropagation && e.stopImmediatePropagation();
          delete e.returnValue;
        }, { capture: true });
      } catch {}
      return true;
    })()`);
  }

  /**
   * Detach from the target and close the parent browser's WebSocket.
   * Safe to call multiple times. Use in `finally` blocks to ensure
   * cleanup after CDP operations complete.
   */
  close(): void {
    try {
      // Detach from target — best-effort, don't await
      this.browser.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => {});
    } catch { /* ignore */ }
    this.browser.close();
  }

  /**
   * Close this tab (remove it from Chrome entirely) and then close
   * the parent browser's WebSocket. Use for tabs we created that
   * should not persist after the operation completes.
   */
  async closeAndCleanup(): Promise<void> {
    try {
      await this.browser.closeTarget(this.targetId);
    } catch { /* best effort */ }
    this.browser.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * High-level helper: pick a page in the right Chrome profile for X
 * posting. Prefers a pre-existing x.com tab (it pins both the profile
 * and confirms identity by URL); otherwise opens a new tab inside a
 * target profile's browserContextId, which is the only way CDP lets us
 * address "this specific profile" reliably.
 *
 * Returns `null` when no tab exists and we can't narrow down the right
 * browserContextId — callers must handle that explicitly; this module
 * intentionally does not guess.
 */
export async function findOrOpenXTab(browser: RawCdpBrowser): Promise<RawCdpPage | null> {
  const targets = await browser.getTargets();
  const xTarget = targets.find((t) => t.type === 'page' && /https:\/\/(x|twitter)\.com/.test(t.url));
  if (xTarget) {
    logger.debug({ targetId: xTarget.targetId.slice(0, 8), ctx: xTarget.browserContextId?.slice(0, 8), url: xTarget.url }, '[raw-cdp] attaching to existing x.com tab');
    return browser.attachToPage(xTarget.targetId);
  }
  // No x.com tab. Can't open one without knowing which profile context
  // to use. Return null — the caller will surface a clear error.
  return null;
}
