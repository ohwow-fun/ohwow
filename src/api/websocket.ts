/**
 * WebSocket Server
 * Bridges EventBus events to connected browser clients for real-time updates.
 * Attaches to the existing HTTP server at path /ws.
 *
 * Authentication accepts BOTH local session tokens (CLI/test clients) and
 * cloud-issued content tokens (dashboard). The dashboard never sees the
 * local session token — it only has access to the ES256 content token
 * signed by the workspace's private key on the cloud side. Without this
 * dual-auth the dashboard would close every connection immediately with
 * 4001 Invalid session token, and the browser would surface the rapid
 * close as "Invalid frame header" instead of a clean auth error.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents, RuntimeEventName } from '../tui/types.js';
import { createWsAuthVerifier } from './ws-auth.js';

const HEARTBEAT_INTERVAL = 30_000;

/** Events forwarded from EventBus to WebSocket clients */
const FORWARDED_EVENTS: RuntimeEventName[] = [
  'task:started',
  'task:completed',
  'task:failed',
  'task:progress',
  'task:upserted',
  'task:removed',
  'memory:extracted',
  'cloud:connected',
  'cloud:disconnected',
  'agent:upserted',
  'agent:removed',
  'activity:created',
  'contact:upserted',
  'contact:removed',
  'department:upserted',
  'department:removed',
  'whatsapp:qr',
  'whatsapp:connected',
  'whatsapp:disconnected',
  'ollama:models-changed',
  'ollama:model-changed',
  'inference:capabilities-changed',
  'model:switch-started',
  'model:switch-complete',
  'model:switch-failed',
  'project:created',
  'project:updated',
  'cloud:replaced',
  'mcp:elicitation',
  'credits:exhausted',
  'budget:warning',
  'budget:exceeded',
];

interface WsClient extends WebSocket {
  isAlive?: boolean;
}

/**
 * Attach a WebSocket server to an existing HTTP server.
 * Bridges EventBus events to all connected clients as JSON messages.
 *
 * @param contentPublicKey — ES256 public key (JWK) used to verify cloud-
 *   issued content tokens from the dashboard. When omitted, only the local
 *   session token is accepted (CLI/test clients).
 */
export function attachWebSocket(
  server: Server,
  eventBus: TypedEventBus<RuntimeEvents>,
  sessionToken: string,
  contentPublicKey?: JsonWebKey,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const verifyToken = createWsAuthVerifier({ sessionToken, cloudPublicKey: contentPublicKey });

  // Heartbeat: ping every 30s, terminate unresponsive clients
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<WsClient>) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  wss.on('connection', async (ws: WsClient, req) => {
    // Support query-param auth (legacy CLI/test clients): ?token=<local-session>
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const queryToken = url.searchParams.get('token');

    if (queryToken) {
      const queryAuth = await verifyToken(queryToken);
      if (queryAuth) {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
        return;
      }
      // Invalid query token — fall through to first-message auth so the
      // dashboard's { type: 'auth', token } flow still has a chance.
    }

    // First-message auth: wait for { type: 'auth', token: '...' } within 5s.
    // Accepts both local session tokens AND ES256 cloud content tokens via
    // createWsAuthVerifier so the cloud dashboard can connect through the
    // Cloudflare tunnel using the same content token it uses for every
    // other runtime HTTP request.
    const authTimeout = setTimeout(() => {
      ws.close(4001, 'Auth timeout');
    }, 5_000);

    ws.once('message', async (data) => {
      clearTimeout(authTimeout);
      try {
        const msg = JSON.parse(String(data)) as { type?: string; token?: string };
        if (msg.type !== 'auth' || !msg.token) {
          ws.close(4001, 'Expected auth message');
          return;
        }
        const authResult = await verifyToken(msg.token);
        if (!authResult) {
          ws.close(4001, 'Invalid token');
          return;
        }
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
      } catch {
        ws.close(4001, 'Invalid auth message');
      }
    });
  });

  // Bridge EventBus → WebSocket broadcast
  function broadcast(eventName: string, payload: unknown) {
    const message = JSON.stringify({ type: eventName, data: payload, timestamp: Date.now() });
    for (const ws of wss.clients as Set<WsClient>) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  for (const eventName of FORWARDED_EVENTS) {
    eventBus.on(eventName, (payload: unknown) => {
      broadcast(eventName, payload);
    });
  }

  return wss;
}
