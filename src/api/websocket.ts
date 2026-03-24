/**
 * WebSocket Server
 * Bridges EventBus events to connected browser clients for real-time updates.
 * Attaches to the existing HTTP server at path /ws.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents, RuntimeEventName } from '../tui/types.js';

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
  'project:created',
  'project:updated',
  'cloud:replaced',
  'mcp:elicitation',
  'credits:exhausted',
];

interface WsClient extends WebSocket {
  isAlive?: boolean;
}

/**
 * Attach a WebSocket server to an existing HTTP server.
 * Bridges EventBus events to all connected clients as JSON messages.
 */
export function attachWebSocket(
  server: Server,
  eventBus: TypedEventBus<RuntimeEvents>,
  sessionToken: string,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

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

  wss.on('connection', (ws: WsClient, req) => {
    // Support both query-param auth (legacy) and first-message auth
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (token === sessionToken) {
      // Legacy query-param auth — accept immediately
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
      return;
    }

    // First-message auth: wait for { type: 'auth', token: '...' } within 5s
    const authTimeout = setTimeout(() => {
      ws.close(4001, 'Auth timeout');
    }, 5_000);

    ws.once('message', (data) => {
      clearTimeout(authTimeout);
      try {
        const msg = JSON.parse(String(data)) as { type?: string; token?: string };
        if (msg.type === 'auth' && msg.token === sessionToken) {
          ws.isAlive = true;
          ws.on('pong', () => { ws.isAlive = true; });
          ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
        } else {
          ws.close(4001, 'Invalid session token');
        }
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
