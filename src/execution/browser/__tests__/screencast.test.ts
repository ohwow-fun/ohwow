/**
 * Unit tests for the CDP screencast helper.
 *
 * Freezes the contract the `/ws/screencast` endpoint and any future
 * caller relies on:
 *   - startScreencast issues `Page.startScreencast` against the given
 *     attach sessionId with JPEG/quality/dims defaults customer streaming
 *     expects.
 *   - Every inbound `Page.screencastFrame` is acked via
 *     `Page.screencastFrameAck` so Chrome keeps emitting.
 *   - onFrame fires with the CDP base64 `data` (no data-URL prefix).
 *   - The 24fps time-guard drops frames that arrive faster than target.
 *   - Frames routed to other attach sessionIds are ignored.
 *   - stopScreencast is idempotent and tolerates a closed target.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { startScreencast, stopScreencast, isScreencastActive } from '../screencast.js';
import type { RawCdpBrowser } from '../raw-cdp.js';

type FrameListener = (params: unknown, sessionId?: string) => void;

/**
 * Minimal stub of the RawCdpBrowser surface the screencast helper
 * actually uses: `.send()` and `.on('Page.screencastFrame', ...)`. We
 * spy on send() to assert CDP commands issued, and capture the frame
 * listener so tests can synthesize CDP events without a real Chrome.
 */
function makeFakeBrowser(): {
  browser: RawCdpBrowser;
  send: ReturnType<typeof vi.fn>;
  emitFrame: (params: Record<string, unknown>, sessionId: string) => void;
  listeners: Map<string, FrameListener[]>;
} {
  const listeners = new Map<string, FrameListener[]>();
  const send = vi.fn().mockResolvedValue({});
  const on = (method: string, handler: FrameListener): (() => void) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method)!.push(handler);
    return () => {
      const arr = listeners.get(method);
      if (!arr) return;
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    };
  };
  const emitFrame = (params: Record<string, unknown>, sessionId: string) => {
    const arr = listeners.get('Page.screencastFrame') ?? [];
    for (const l of arr) l(params, sessionId);
  };
  const browser = { send, on } as unknown as RawCdpBrowser;
  return { browser, send, emitFrame, listeners };
}

describe('screencast helper', () => {
  beforeEach(async () => {
    // Ensure any leftover active registry entries from prior tests
    // don't leak — the module exports an idempotent stopScreencast
    // which is the only public tool for that.
    const fake = makeFakeBrowser();
    for (const sid of ['s1', 's2', 's3', 'session-a', 'session-b', 'shared-session']) {
      if (isScreencastActive(sid)) await stopScreencast(fake.browser, sid);
    }
  });

  describe('startScreencast', () => {
    it('issues Page.startScreencast with JPEG + 24fps defaults against the attach sessionId', async () => {
      const { browser, send } = makeFakeBrowser();

      await startScreencast(browser, 's1', () => {});

      // Page.startScreencast is the last CDP call. Older engines used to
      // enable Page domain here too, but the helper delegates that to
      // the attach path, so we only assert on the start call itself.
      const startCall = send.mock.calls.find(([m]) => m === 'Page.startScreencast');
      expect(startCall).toBeDefined();
      const [, params, routedSessionId] = startCall!;
      expect(params).toEqual({
        format: 'jpeg',
        quality: 60,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 3,
      });
      expect(routedSessionId).toBe('s1');
      expect(isScreencastActive('s1')).toBe(true);
    });

    it('forwards the base64 JPEG `data` field (no data-URL prefix) to onFrame', async () => {
      const { browser, emitFrame } = makeFakeBrowser();
      const received: Array<{ data: string; sessionId: string }> = [];

      await startScreencast(browser, 's1', (frame) => {
        received.push({ data: frame.data, sessionId: frame.sessionId });
      });

      emitFrame({ data: 'BASE64JPEG', sessionId: 42, metadata: { timestamp: 123.456 } }, 's1');

      expect(received).toHaveLength(1);
      expect(received[0].data).toBe('BASE64JPEG');
      expect(received[0].data).not.toMatch(/^data:/);
      expect(received[0].sessionId).toBe('s1');
    });

    it('acks every frame with Page.screencastFrameAck carrying the per-frame sessionId', async () => {
      const { browser, send, emitFrame } = makeFakeBrowser();
      await startScreencast(browser, 's1', () => {});

      emitFrame({ data: 'F1', sessionId: 101 }, 's1');

      const ack = send.mock.calls.find(
        ([m, params]) => m === 'Page.screencastFrameAck' && (params as { sessionId: number }).sessionId === 101,
      );
      expect(ack).toBeDefined();
      // ack must be routed to OUR attach session (not the per-frame id).
      expect(ack![2]).toBe('s1');
    });

    it('ignores frames routed to a different attach sessionId', async () => {
      const { browser, emitFrame } = makeFakeBrowser();
      const onFrame = vi.fn();

      await startScreencast(browser, 'session-a', onFrame);
      emitFrame({ data: 'F', sessionId: 1 }, 'session-b');

      expect(onFrame).not.toHaveBeenCalled();
    });

    it('drops frames that arrive faster than targetFps (24fps time-guard)', async () => {
      const { browser, emitFrame } = makeFakeBrowser();
      const onFrame = vi.fn();

      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        await startScreencast(browser, 's1', onFrame, { targetFps: 24 });

        // Feed 48 frames in "the same 1000ms" — 24fps means ~41ms
        // between forwarded frames, so half should drop.
        for (let i = 0; i < 48; i++) {
          vi.setSystemTime(Math.floor((i * 1000) / 48)); // ~20.8ms apart
          emitFrame({ data: `F${i}`, sessionId: i }, 's1');
        }
      } finally {
        vi.useRealTimers();
      }

      // 48 frames at ~20.8ms intervals, min gap 41ms => at most ~24 forwarded.
      expect(onFrame.mock.calls.length).toBeLessThan(48);
      expect(onFrame.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('rolls back registry entry when Page.startScreencast rejects', async () => {
      const { browser, send } = makeFakeBrowser();
      send.mockImplementation(async (method: string) => {
        if (method === 'Page.startScreencast') throw new Error('boom');
        return {};
      });

      await expect(startScreencast(browser, 's1', () => {})).rejects.toThrow('boom');
      expect(isScreencastActive('s1')).toBe(false);
    });

    it('is a no-op when called twice for the same sessionId', async () => {
      const { browser, send } = makeFakeBrowser();
      await startScreencast(browser, 'shared-session', () => {});
      const callsAfterFirst = send.mock.calls.filter(([m]) => m === 'Page.startScreencast').length;

      await startScreencast(browser, 'shared-session', () => {});
      const callsAfterSecond = send.mock.calls.filter(([m]) => m === 'Page.startScreencast').length;

      expect(callsAfterFirst).toBe(1);
      expect(callsAfterSecond).toBe(1);
    });
  });

  describe('stopScreencast', () => {
    it('issues Page.stopScreencast and clears the active-session flag', async () => {
      const { browser, send } = makeFakeBrowser();
      await startScreencast(browser, 's1', () => {});
      expect(isScreencastActive('s1')).toBe(true);

      await stopScreencast(browser, 's1');

      expect(send).toHaveBeenCalledWith('Page.stopScreencast', {}, 's1');
      expect(isScreencastActive('s1')).toBe(false);
    });

    it('is idempotent — safe when no screencast is active', async () => {
      const { browser, send } = makeFakeBrowser();
      await stopScreencast(browser, 'never-started');

      const stopCalls = send.mock.calls.filter(([m]) => m === 'Page.stopScreencast');
      expect(stopCalls).toHaveLength(0);
    });

    it('swallows CDP errors (target may already be gone)', async () => {
      const { browser, send } = makeFakeBrowser();
      await startScreencast(browser, 's1', () => {});
      send.mockImplementation(async (method: string) => {
        if (method === 'Page.stopScreencast') throw new Error('Target closed');
        return {};
      });

      await expect(stopScreencast(browser, 's1')).resolves.toBeUndefined();
      expect(isScreencastActive('s1')).toBe(false);
    });

    it('stops forwarding frames after stop even if Chrome keeps emitting', async () => {
      const { browser, emitFrame } = makeFakeBrowser();
      const onFrame = vi.fn();

      await startScreencast(browser, 's1', onFrame, { targetFps: 60 });
      emitFrame({ data: 'before', sessionId: 1 }, 's1');
      await stopScreencast(browser, 's1');
      emitFrame({ data: 'after', sessionId: 2 }, 's1');

      expect(onFrame).toHaveBeenCalledTimes(1);
      expect(onFrame.mock.calls[0][0].data).toBe('before');
    });
  });
});
