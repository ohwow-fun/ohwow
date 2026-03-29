/**
 * WebSocket Client
 * Auto-reconnecting WebSocket that triggers data refetches on events.
 */

import { getToken } from './client';

type EventHandler = (event: string, data: unknown) => void;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const handlers = new Set<EventHandler>();

const RECONNECT_DELAY = 3000;

function getWsUrl(): string {
  const token = getToken();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = import.meta.env.DEV ? 'localhost:7700' : window.location.host;
  return `${protocol}//${host}/ws?token=${token}`;
}

export function connectWebSocket() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  const token = getToken();
  if (!token) return;

  try {
    ws = new WebSocket(getWsUrl());

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        for (const handler of handlers) {
          handler(msg.type, msg.data);
        }
      } catch {
        // Skip malformed messages
      }
    };

    ws.onclose = () => {
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws?.close();
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, RECONNECT_DELAY);
}

export function disconnectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  ws?.close();
  ws = null;
}

export function onWsEvent(handler: EventHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
