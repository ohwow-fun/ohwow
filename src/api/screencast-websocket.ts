/**
 * Screencast WebSocket
 * Dedicated /ws/screencast endpoint for streaming the active ohwow-
 * driven browser tab's framebuffer to subscribed clients as base64
 * JPEG frames. Mounted alongside /ws/terminal and /ws/voice and
 * auth-guarded with the same shared `createWsAuthVerifier` flow.
 *
 * Protocol (all messages JSON):
 *   Client -> Server:
 *     { type: 'auth', token: string }
 *     { type: 'subscribe', targetId?: string }
 *     { type: 'unsubscribe' }
 *
 *   Server -> Client:
 *     { type: 'authenticated' }
 *     { type: 'status', state: 'active' | 'idle' | 'error', reason?: string }
 *     { type: 'frame', data: string (base64 JPEG), sessionId: string, timestamp?: number, ts: number }
 *     { type: 'error', message: string }
 *
 * Frame fanout model
 * ------------------
 * Multiple clients can subscribe to the same underlying browser target.
 * We keep ONE CDP screencast per target — the first subscriber spins
 * it up, every subsequent subscriber just joins the broadcast set. The
 * last unsubscribe (or disconnect) tears the CDP screencast down and
 * releases the RawCdpBrowser connection.
 *
 * Target resolution
 * -----------------
 * `subscribe.targetId` is optional. When omitted we pick the most
 * recently-claimed ohwow-owned page from `browser-claims.debugSnapshot`
 * — the same signal every agent tool uses to pin work. When no agent
 * currently owns a tab we emit `status: idle` and hold the socket
 * open; the next subscribe attempt will re-resolve.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { createWsAuthVerifier, type WsAuthDeps } from './ws-auth.js';
import { logger } from '../lib/logger.js';
import { ensureCdpBrowser } from '../execution/browser/chrome-profile-router.js';
import { debugSnapshot } from '../execution/browser/browser-claims.js';
import { startScreencast, stopScreencast } from '../execution/browser/screencast.js';
import type { RawCdpBrowser } from '../execution/browser/raw-cdp.js';

export interface ScreencastWebSocketDeps extends WsAuthDeps {
  server: Server;
}

interface ScreencastClient extends WebSocket {
  isAlive?: boolean;
  authenticated?: boolean;
  /** CDP target id this client is currently watching, or undefined. */
  subscribedTargetId?: string;
}

/**
 * Per-target broadcast group. Holds the long-lived RawCdpBrowser
 * connection, the attach session id (CDP's), and the subscriber set.
 */
interface TargetGroup {
  targetId: string;
  browser: RawCdpBrowser;
  attachSessionId: string;
  subscribers: Set<ScreencastClient>;
}

// Module-level registry. One entry per live screencast target, shared
// across every WS client subscribed to that target.
const groups = new Map<string, TargetGroup>();

// Serialize concurrent subscribe calls against the same targetId.
// Without this, two clients subscribing in the same event-loop tick
// both see "no group yet" and each spin up their own RawCdpBrowser.
const pendingStarts = new Map<string, Promise<TargetGroup | null>>();

/**
 * Attach the screencast WebSocket server at /ws/screencast.
 */
export function attachScreencastWebSocket(deps: ScreencastWebSocketDeps): WebSocketServer {
  const { server } = deps;
  const verifyToken = createWsAuthVerifier(deps);

  // noServer mode so multiple ws servers can share the same HTTP server
  // without stepping on each other's upgrade events. See websocket.ts.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    if (url.pathname !== '/ws/screencast') return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  // Heartbeat — terminate unresponsive clients
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<ScreencastClient>) {
      if (!ws.isAlive) {
        cleanupClient(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: ScreencastClient) => {
    ws.isAlive = true;
    ws.authenticated = false;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      handleMessage(ws, data.toString(), verifyToken).catch((err) => {
        logger.error({ err }, '[screencast-ws] Unhandled error in message handler');
        sendJson(ws, { type: 'error', message: 'Internal error' });
      });
    });

    ws.on('close', () => cleanupClient(ws));
    ws.on('error', () => cleanupClient(ws));
  });

  logger.info('[screencast-ws] WebSocket server attached at /ws/screencast');

  return wss;
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

type TokenVerifier = (token: string) => Promise<{ workspaceId: string; userId: string } | null>;

async function handleMessage(
  ws: ScreencastClient,
  raw: string,
  verifyToken: TokenVerifier,
): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    sendJson(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  const type = msg.type as string;

  // Auth must be first message — same pattern as /ws/terminal.
  if (!ws.authenticated) {
    if (type !== 'auth' || typeof msg.token !== 'string') {
      sendJson(ws, { type: 'error', message: 'First message must be { type: "auth", token: "..." }' });
      ws.close(4001, 'Auth required');
      return;
    }

    const result = await verifyToken(msg.token as string);
    if (!result) {
      sendJson(ws, { type: 'error', message: 'Invalid or expired token' });
      ws.close(4001, 'Auth failed');
      return;
    }

    ws.authenticated = true;
    logger.info(
      { workspaceId: result.workspaceId, userId: result.userId },
      '[screencast-ws] Client authenticated',
    );
    sendJson(ws, { type: 'authenticated' });
    return;
  }

  switch (type) {
    case 'subscribe':
      await handleSubscribe(ws, msg);
      break;
    case 'unsubscribe':
      await handleUnsubscribe(ws);
      break;
    default:
      sendJson(ws, { type: 'error', message: `Unknown message type: ${type}` });
  }
}

async function handleSubscribe(ws: ScreencastClient, msg: Record<string, unknown>): Promise<void> {
  // One subscription per connection — switching targets requires an
  // explicit unsubscribe first so fanout accounting stays honest.
  if (ws.subscribedTargetId) {
    sendJson(ws, { type: 'error', message: 'Already subscribed. Send { type: "unsubscribe" } first.' });
    return;
  }

  const explicitTargetId = typeof msg.targetId === 'string' && msg.targetId.length > 0
    ? (msg.targetId as string)
    : null;

  const targetId = explicitTargetId ?? resolveActiveTargetId();
  if (!targetId) {
    // No ohwow-driven tab right now. Tell the client so the UI can
    // show a helpful "nothing to stream yet" state and keep the
    // socket open for a later retry.
    sendJson(ws, { type: 'status', state: 'idle', reason: 'No active ohwow-driven browser tab' });
    return;
  }

  let group: TargetGroup | null;
  try {
    group = await acquireGroup(targetId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Couldn\'t start screencast';
    logger.error({ err, targetId }, '[screencast-ws] Couldn\'t acquire screencast group');
    sendJson(ws, { type: 'status', state: 'error', reason: message });
    return;
  }

  if (!group) {
    sendJson(ws, { type: 'status', state: 'error', reason: 'Couldn\'t attach to browser target' });
    return;
  }

  group.subscribers.add(ws);
  ws.subscribedTargetId = targetId;
  sendJson(ws, { type: 'status', state: 'active' });
  logger.debug(
    { targetId, subscribers: group.subscribers.size },
    '[screencast-ws] Client subscribed',
  );
}

async function handleUnsubscribe(ws: ScreencastClient): Promise<void> {
  const targetId = ws.subscribedTargetId;
  if (!targetId) return;

  ws.subscribedTargetId = undefined;
  const group = groups.get(targetId);
  if (!group) return;

  group.subscribers.delete(ws);
  sendJson(ws, { type: 'status', state: 'idle' });

  if (group.subscribers.size === 0) {
    await teardownGroup(targetId);
  }
}

// ============================================================================
// GROUP LIFECYCLE
// ============================================================================

/**
 * Pick the target id a new subscriber should attach to when the
 * client didn't name one. We use the most recently claimed ohwow-
 * owned tab — same signal agent tools use to pin work — because it
 * is the one the customer most likely wants to see live.
 */
function resolveActiveTargetId(): string | null {
  const claims = debugSnapshot();
  if (claims.length === 0) return null;
  // Sort by claimedAt DESC so the most recent owner wins.
  claims.sort((a, b) => b.claimedAt - a.claimedAt);
  return claims[0].key.targetId;
}

async function acquireGroup(targetId: string): Promise<TargetGroup | null> {
  const existing = groups.get(targetId);
  if (existing) return existing;

  // Serialize with any in-flight start for the same targetId so two
  // subscribers racing the first frame share one RawCdpBrowser.
  const pending = pendingStarts.get(targetId);
  if (pending) return pending;

  const startPromise = (async (): Promise<TargetGroup | null> => {
    const browser = await ensureCdpBrowser({});
    let attachSessionId: string | null = null;
    try {
      // Attach to the target directly so we get a CDP session id we
      // control. We do NOT enable Page domain via `attachToPage` here
      // because that helper assumes a page-wide setup (dialog accept
      // etc.) this consumer doesn't want. Instead we use a minimal
      // attach and Page.enable by hand.
      const r = await browser.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId, flatten: true },
      );
      attachSessionId = r.sessionId;
      await browser.send('Page.enable', {}, attachSessionId);

      const group: TargetGroup = {
        targetId,
        browser,
        attachSessionId,
        subscribers: new Set(),
      };

      await startScreencast(browser, attachSessionId, (frame) => {
        broadcastFrame(group, frame.data, frame.timestamp);
      });

      groups.set(targetId, group);
      return group;
    } catch (err) {
      // Best-effort cleanup of the dangling browser connection if we
      // failed partway through.
      try { browser.close(); } catch { /* ignore */ }
      throw err;
    }
  })();

  pendingStarts.set(targetId, startPromise);
  try {
    return await startPromise;
  } finally {
    pendingStarts.delete(targetId);
  }
}

async function teardownGroup(targetId: string): Promise<void> {
  const group = groups.get(targetId);
  if (!group) return;
  groups.delete(targetId);
  try {
    await stopScreencast(group.browser, group.attachSessionId);
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, targetId },
      '[screencast-ws] stopScreencast during teardown failed (non-fatal)',
    );
  }
  try { group.browser.close(); } catch { /* ignore */ }
  logger.info({ targetId }, '[screencast-ws] Screencast group torn down');
}

function broadcastFrame(group: TargetGroup, data: string, timestamp?: number): void {
  if (group.subscribers.size === 0) return;
  const payload = JSON.stringify({
    type: 'frame',
    data,
    sessionId: group.attachSessionId,
    timestamp,
    ts: Date.now(),
  });
  for (const ws of group.subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function cleanupClient(ws: ScreencastClient): void {
  const targetId = ws.subscribedTargetId;
  if (!targetId) return;

  ws.subscribedTargetId = undefined;
  const group = groups.get(targetId);
  if (!group) return;

  group.subscribers.delete(ws);
  if (group.subscribers.size === 0) {
    // Fire-and-forget — cleanup on socket close can't be async.
    teardownGroup(targetId).catch((err) => {
      logger.debug(
        { err: err instanceof Error ? err.message : err, targetId },
        '[screencast-ws] teardownGroup on disconnect failed (non-fatal)',
      );
    });
  }
}

function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
