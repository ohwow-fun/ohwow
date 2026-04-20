/**
 * Freeze tests: raw-cdp.ts structured cdp:true log events.
 *
 * Kept separate from cdp-trace-logs.test.ts because that file mocks
 * raw-cdp.js at the module level (for chrome-profile-router tests), which
 * would make RawCdpBrowser.prototype unavailable here.
 *
 * Tests:
 *   - RawCdpBrowser.attachToPage → { cdp: true, action: 'tab:attach', targetId }
 *   - RawCdpPage.goto            → { cdp: true, action: 'navigate', targetId, url }
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDebug } = vi.hoisted(() => ({
  mockDebug: vi.fn(),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: mockDebug,
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  },
}));

import { RawCdpBrowser } from '../raw-cdp.js';

/** Extract all logger.debug calls that have cdp:true in the first arg. */
function cdpDebugCalls(): Array<Record<string, unknown>> {
  return mockDebug.mock.calls
    .filter((args) => args[0] && typeof args[0] === 'object' && (args[0] as Record<string, unknown>).cdp === true)
    .map((args) => args[0] as Record<string, unknown>);
}

/**
 * Build a minimal RawCdpBrowser instance backed by a fake `send` function,
 * bypassing the private constructor by using Object.create.
 */
function makeFakeBrowser(sendImpl: (method: string, params?: unknown, sessionId?: string) => Promise<unknown>): RawCdpBrowser {
  const browser = Object.create(RawCdpBrowser.prototype) as RawCdpBrowser;
  const eventListeners = new Map<string, Array<(p: unknown, sid?: string) => void>>();
  Object.assign(browser, {
    ws: null,
    nextId: 0,
    pending: new Map(),
    eventListeners,
    closed: false,
    wsUrl: 'ws://fake',
    send: sendImpl,
    on: (event: string, cb: (p: unknown, sid?: string) => void) => {
      if (!eventListeners.has(event)) eventListeners.set(event, []);
      eventListeners.get(event)!.push(cb);
      return () => {
        const arr = eventListeners.get(event) ?? [];
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
      };
    },
  });
  return browser;
}

describe('raw-cdp: RawCdpBrowser.attachToPage emits structured tab:attach log', () => {
  beforeEach(() => {
    mockDebug.mockClear();
  });

  it('emits { cdp: true, action: "tab:attach", targetId } before attaching', async () => {
    let callCount = 0;
    const browser = makeFakeBrowser(async (method) => {
      callCount++;
      if (method === 'Target.attachToTarget') return { sessionId: 'sess-mock' };
      return {};
    });

    await browser.attachToPage('target-xyz');

    const attachCalls = cdpDebugCalls().filter((c) => c.action === 'tab:attach');
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0]).toMatchObject({
      cdp: true,
      action: 'tab:attach',
      targetId: 'target-xyz',
    });
  });
});

describe('raw-cdp: RawCdpPage.goto emits structured navigate log', () => {
  beforeEach(() => {
    mockDebug.mockClear();
  });

  it('emits { cdp: true, action: "navigate", targetId, url } on goto()', async () => {
    // Build a browser where attachToPage returns a page, then call goto.
    let navigateCalled = false;
    const browser = makeFakeBrowser(async (method) => {
      if (method === 'Target.attachToTarget') return { sessionId: 'sess-nav' };
      if (method === 'Page.enable') return {};
      if (method === 'Runtime.enable') return {};
      if (method === 'Page.navigate') { navigateCalled = true; return {}; }
      // Page.lifecycleEvent is awaited via waitForEvent — simulate by returning {}
      return {};
    });

    const page = await browser.attachToPage('nav-target-01');
    mockDebug.mockClear(); // clear tab:attach call so we can isolate navigate

    // goto calls Page.navigate then waitForLoad (waitForEvent for lifecycleEvent).
    // We mock send to immediately resolve so goto doesn't hang.
    // The page's `send` is the browser's `send` routed with sessionId.
    // waitForLoad sets up a listener for 'Page.lifecycleEvent' — we need to
    // fire it. We do so by triggering it on the eventListeners map after goto starts.

    // Run goto in the background, then fire Page.loadEventFired after a microtask
    // so waitForLoad's listener has time to register before we emit.
    let gotoResolved = false;
    const gotoPromise = page.goto('https://x.com/home').then(() => { gotoResolved = true; });

    const listeners = (browser as unknown as { eventListeners: Map<string, Array<(p: unknown, sid?: string) => void>> }).eventListeners;

    // Poll until Page.loadEventFired listener is registered (goto -> Page.navigate -> waitForLoad)
    // At most 50ms — the listener is registered synchronously inside waitForLoad's Promise constructor.
    await new Promise<void>((resolve) => {
      const tryFire = () => {
        const lcListeners = listeners.get('Page.loadEventFired') ?? [];
        if (lcListeners.length > 0) {
          for (const cb of lcListeners) cb({}, 'sess-nav');
          resolve();
        } else {
          setTimeout(tryFire, 1);
        }
      };
      setTimeout(tryFire, 1);
    });

    await gotoPromise;

    const navigateCalls = cdpDebugCalls().filter((c) => c.action === 'navigate');
    expect(navigateCalls).toHaveLength(1);
    expect(navigateCalls[0]).toMatchObject({
      cdp: true,
      action: 'navigate',
      targetId: 'nav-target-01',
      url: 'https://x.com/home',
    });
    expect(navigateCalled).toBe(true);
  });
});
