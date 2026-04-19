/**
 * Integration tests for the `/ws/screencast` WebSocket endpoint.
 *
 * Freezes the contract customers on /dashboard/<slug>/live depend on
 * (cloud consumer + live page land in Trio B):
 *   - Auth: missing / invalid token -> close with 4001. Valid local
 *     session token -> `{ type: 'authenticated' }`.
 *   - Subscribe lifecycle: first subscriber wires up CDP via
 *     `ensureCdpBrowser` + `Page.startScreencast`; last disconnect stops
 *     the screencast and closes the browser connection.
 *   - Frame envelope: `{ type: 'frame', data, sessionId, timestamp, ts }`
 *     with `data` a base64 string.
 *   - Status envelope: `{ type: 'status', state: 'active'|'idle'|'error', reason? }`.
 *   - Idle path: when no ohwow-driven tab is claimed, subscribe yields
 *     `{ type: 'status', state: 'idle' }` (no throw, socket stays open).
 *
 * The CDP surface is mocked end-to-end. No real Chrome, no real daemon.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Mocks — must be defined with vi.mock at module top so the SUT imports them.
// ---------------------------------------------------------------------------

type FrameHandler = (params: unknown, sessionId?: string) => void;

interface FakeBrowser {
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitFrame: (params: Record<string, unknown>, sessionId: string) => void;
  emitTargetDestroyed: (targetId: string) => void;
}

let currentBrowser: FakeBrowser | null = null;
let snapshotClaims: Array<{ key: { profileDir: string; targetId: string }; owner: string; claimedAt: number }> = [];

function freshBrowser(): FakeBrowser {
  const listeners = new Map<string, FrameHandler[]>();
  let attachCounter = 0;

  const send = vi.fn(async (method: string, params?: Record<string, unknown>, _sessionId?: string) => {
    if (method === 'Target.attachToTarget') {
      attachCounter++;
      return { sessionId: `attach-${attachCounter}` };
    }
    // Page.enable, Page.startScreencast, Page.stopScreencast, screencastFrameAck — all resolve empty.
    void params;
    return {};
  });

  const on = vi.fn((method: string, handler: FrameHandler) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method)!.push(handler);
    return () => {
      const arr = listeners.get(method);
      if (!arr) return;
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    };
  });

  const close = vi.fn();

  const emitFrame = (params: Record<string, unknown>, sessionId: string) => {
    const arr = listeners.get('Page.screencastFrame') ?? [];
    for (const l of arr) l(params, sessionId);
  };

  const emitTargetDestroyed = (targetId: string) => {
    const arr = listeners.get('Target.targetDestroyed') ?? [];
    for (const l of arr) l({ targetId });
  };

  return { send, on, close, emitFrame, emitTargetDestroyed };
}

vi.mock('../../execution/browser/chrome-profile-router.js', () => ({
  ensureCdpBrowser: vi.fn(async () => currentBrowser),
  // ensureTargetDestroyedSubscription is called during acquireGroup; the
  // fake browser's `on` mock already captures the listener registration so
  // we just resolve immediately.
  ensureTargetDestroyedSubscription: vi.fn(async () => {}),
}));

vi.mock('../../execution/browser/browser-claims.js', () => ({
  debugSnapshot: vi.fn(() => snapshotClaims),
}));

// Import the SUT AFTER mocks. Vitest hoists vi.mock but for safety we
// import lazily inside the test setup function.
import { attachScreencastWebSocket } from '../screencast-websocket.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const LOCAL_TOKEN = 'local-session-token-for-tests';

interface Harness {
  server: Server;
  url: string;
  port: number;
}

async function startHarness(): Promise<Harness> {
  const server = createServer();
  attachScreencastWebSocket({ server, sessionToken: LOCAL_TOKEN });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return { server, url: `ws://127.0.0.1:${addr.port}/ws/screencast`, port: addr.port };
}

async function stopHarness(h: Harness): Promise<void> {
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

function openClient(url: string): WebSocket {
  return new WebSocket(url);
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ws message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString())); }
      catch { reject(new Error('non-json ws message')); }
    });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ws close')), timeoutMs);
    ws.once('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/ws/screencast', () => {
  let harness: Harness;

  beforeEach(async () => {
    currentBrowser = freshBrowser();
    snapshotClaims = [];
    harness = await startHarness();
  });

  afterEach(async () => {
    await stopHarness(harness);
    currentBrowser = null;
  });

  describe('auth', () => {
    it('closes the socket when the first message is not auth', async () => {
      const ws = openClient(harness.url);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: 'subscribe' }));
      const err = await nextMessage(ws);
      expect(err).toMatchObject({ type: 'error' });
      const { code } = await waitForClose(ws);
      expect(code).toBe(4001);
    });

    it('rejects an invalid token with a 4001 close', async () => {
      const ws = openClient(harness.url);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: 'auth', token: 'nope' }));
      const err = await nextMessage(ws);
      expect(err).toMatchObject({ type: 'error' });
      const { code } = await waitForClose(ws);
      expect(code).toBe(4001);
    });

    it('accepts the local session token and emits { type: "authenticated" }', async () => {
      const ws = openClient(harness.url);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: 'auth', token: LOCAL_TOKEN }));
      const ok = await nextMessage(ws);
      expect(ok).toEqual({ type: 'authenticated' });

      ws.close();
    });
  });

  describe('subscribe lifecycle', () => {
    it('returns status=idle when no ohwow-driven tab is claimed', async () => {
      // snapshotClaims intentionally empty.
      const ws = openClient(harness.url);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: 'auth', token: LOCAL_TOKEN }));
      await nextMessage(ws); // authenticated

      ws.send(JSON.stringify({ type: 'subscribe' }));
      const status = await nextMessage(ws);
      expect(status).toMatchObject({ type: 'status', state: 'idle' });
      // ensureCdpBrowser must NOT have been called — idle must not spin
      // up a browser just to tell the client "nothing to stream".
      const { ensureCdpBrowser } = await import('../../execution/browser/chrome-profile-router.js');
      expect(ensureCdpBrowser).not.toHaveBeenCalled();

      ws.close();
    });

    it('first subscribe attaches to the most-recently-claimed target and starts the CDP screencast', async () => {
      snapshotClaims = [
        { key: { profileDir: 'Default', targetId: 'older-target' }, owner: 'task-1', claimedAt: 1000 },
        { key: { profileDir: 'Default', targetId: 'newer-target' }, owner: 'task-2', claimedAt: 2000 },
      ];

      const ws = openClient(harness.url);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth', token: LOCAL_TOKEN }));
      await nextMessage(ws);

      ws.send(JSON.stringify({ type: 'subscribe' }));
      const status = await nextMessage(ws);
      expect(status).toMatchObject({ type: 'status', state: 'active' });

      // The helper must have issued the expected CDP sequence against
      // the most recently claimed target.
      const attachCall = currentBrowser!.send.mock.calls.find(([m]) => m === 'Target.attachToTarget');
      expect(attachCall).toBeDefined();
      expect(attachCall![1]).toMatchObject({ targetId: 'newer-target' });

      const startCall = currentBrowser!.send.mock.calls.find(([m]) => m === 'Page.startScreencast');
      expect(startCall).toBeDefined();
      expect(startCall![1]).toMatchObject({ format: 'jpeg' });

      ws.close();
      // Give the server a tick to process disconnect cleanup.
      await new Promise((r) => setTimeout(r, 50));
    });

    it('honors an explicit targetId from the client', async () => {
      // Even though the snapshot names another target, the client's
      // explicit targetId must win.
      snapshotClaims = [
        { key: { profileDir: 'Default', targetId: 'from-snapshot' }, owner: 'task', claimedAt: 1 },
      ];

      const ws = openClient(harness.url);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth', token: LOCAL_TOKEN }));
      await nextMessage(ws);

      ws.send(JSON.stringify({ type: 'subscribe', targetId: 'explicit-target' }));
      const status = await nextMessage(ws);
      expect(status).toMatchObject({ type: 'status', state: 'active' });

      const attachCall = currentBrowser!.send.mock.calls.find(([m]) => m === 'Target.attachToTarget');
      expect(attachCall![1]).toMatchObject({ targetId: 'explicit-target' });

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it('Target.targetDestroyed for the subscribed tab broadcasts idle status and closes the WS with code 4002', async () => {
      const targetId = 'tab-to-be-closed';
      snapshotClaims = [{ key: { profileDir: 'Default', targetId }, owner: 'task', claimedAt: 1 }];

      const ws = openClient(harness.url);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth', token: LOCAL_TOKEN }));
      await nextMessage(ws); // authenticated
      ws.send(JSON.stringify({ type: 'subscribe' }));
      await nextMessage(ws); // status active

      // Set up listeners BEFORE triggering the event.
      const idlePromise = nextMessage(ws);
      const closePromise = waitForClose(ws, 3000);

      // Simulate the browser tab being destroyed externally.
      currentBrowser!.emitTargetDestroyed(targetId);

      // The server must first send { type: 'status', state: 'idle', reason: 'target_closed' }
      // and then close the socket with code 4002.
      const idle = await idlePromise;
      expect(idle).toMatchObject({ type: 'status', state: 'idle', reason: 'target_closed' });

      const { code } = await closePromise;
      expect(code).toBe(4002);

      // Teardown must have fired: stopScreencast + browser.close.
      await vi.waitFor(() => {
        const stopCall = currentBrowser!.send.mock.calls.find(([m]) => m === 'Page.stopScreencast');
        expect(stopCall).toBeDefined();
        expect(currentBrowser!.close).toHaveBeenCalled();
      }, { timeout: 2000 });
    });

    it('Target.targetDestroyed for a DIFFERENT tab does not affect subscribers watching their own target', async () => {
      const myTarget = 'my-tab';
      snapshotClaims = [{ key: { profileDir: 'Default', targetId: myTarget }, owner: 'task', claimedAt: 1 }];

      const ws = openClient(harness.url);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth', token: LOCAL_TOKEN }));
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe' }));
      await nextMessage(ws); // status active

      // Collect any unexpected messages that arrive within 300ms.
      const unexpected: unknown[] = [];
      ws.on('message', (data) => { unexpected.push(JSON.parse(data.toString())); });

      // Emit destroyed for a DIFFERENT targetId — must be a no-op for our subscriber.
      currentBrowser!.emitTargetDestroyed('some-other-tab');

      // Give the event loop time to propagate any unexpected messages or closes.
      await new Promise((r) => setTimeout(r, 300));

      // Socket must still be open and no messages must have arrived.
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(unexpected).toHaveLength(0);

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it('last subscriber disconnect stops the screencast and closes the browser connection', async () => {
      snapshotClaims = [{ key: { profileDir: 'Default', targetId: 't1' }, owner: 'task', claimedAt: 1 }];

      const ws = openClient(harness.url);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth', token: LOCAL_TOKEN }));
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe' }));
      await nextMessage(ws); // status active

      ws.close();

      // Wait for the server's close handler to run the async teardown.
      await vi.waitFor(() => {
        const stopCall = currentBrowser!.send.mock.calls.find(([m]) => m === 'Page.stopScreencast');
        expect(stopCall).toBeDefined();
        expect(currentBrowser!.close).toHaveBeenCalled();
      }, { timeout: 2000 });
    });
  });

  describe('frame + status envelopes', () => {
    it('emits { type: "frame", data, sessionId, timestamp?, ts } with base64 data', async () => {
      snapshotClaims = [{ key: { profileDir: 'Default', targetId: 't1' }, owner: 'task', claimedAt: 1 }];

      const ws = openClient(harness.url);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth', token: LOCAL_TOKEN }));
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe' }));
      await nextMessage(ws); // status active

      const framePromise = nextMessage(ws);

      // Simulate CDP emitting a frame against OUR attach session.
      // freshBrowser assigns `attach-1` for the first attach call.
      currentBrowser!.emitFrame(
        { data: 'BASE64JPEGDATA', sessionId: 99, metadata: { timestamp: 123.456 } },
        'attach-1',
      );

      const frame = await framePromise;
      expect(frame).toMatchObject({
        type: 'frame',
        data: 'BASE64JPEGDATA',
        sessionId: 'attach-1',
        timestamp: 123.456,
      });
      expect(typeof (frame as { ts: number }).ts).toBe('number');

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it('also sends Page.screencastFrameAck back to Chrome for every forwarded frame', async () => {
      snapshotClaims = [{ key: { profileDir: 'Default', targetId: 't1' }, owner: 'task', claimedAt: 1 }];

      const ws = openClient(harness.url);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth', token: LOCAL_TOKEN }));
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe' }));
      await nextMessage(ws);

      currentBrowser!.emitFrame({ data: 'X', sessionId: 7 }, 'attach-1');

      // The ack is async — wait for it.
      await vi.waitFor(() => {
        const ack = currentBrowser!.send.mock.calls.find(
          ([m, params]) => m === 'Page.screencastFrameAck' && (params as { sessionId: number }).sessionId === 7,
        );
        expect(ack).toBeDefined();
      });

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it('propagates errors as { type: "status", state: "error", reason }', async () => {
      snapshotClaims = [{ key: { profileDir: 'Default', targetId: 't-bad' }, owner: 'task', claimedAt: 1 }];
      // Make Page.startScreencast reject — acquireGroup should surface
      // this as a status:error frame, not a thrown 500 / dropped socket.
      currentBrowser!.send.mockImplementation(async (method: string) => {
        if (method === 'Target.attachToTarget') return { sessionId: 'attach-err' };
        if (method === 'Page.startScreencast') throw new Error('cdp boom');
        return {};
      });

      const ws = openClient(harness.url);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'auth', token: LOCAL_TOKEN }));
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe' }));

      const status = await nextMessage(ws);
      expect(status).toMatchObject({ type: 'status', state: 'error' });
      expect((status as { reason: string }).reason).toMatch(/boom/i);

      ws.close();
    });
  });
});
