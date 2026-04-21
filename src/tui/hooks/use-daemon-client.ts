/**
 * useDaemonClient Hook
 * Thin HTTP/WebSocket client that connects the TUI to a running daemon.
 * Replaces direct DB/service access when running in client mode.
 *
 * Features:
 * - Exponential backoff on WS reconnect (1s → 2s → 4s → ... → 30s)
 * - Re-reads session token from disk on reconnect (handles daemon restart)
 * - Crash recovery: detects dead daemon, re-spawns, reconnects
 */

import { useState, useEffect, useRef } from 'react';
import type { WhatsAppConnectionStatus } from '../../whatsapp/types.js';
import { getEventBus } from './use-event-bus.js';
import { registerShutdown } from './shutdown-registry.js';
import { getDaemonSessionToken, startDaemonBackground, waitForDaemon } from '../../daemon/lifecycle.js';
import { readLock, isProcessAlive } from '../../lib/instance-lock.js';

interface DaemonClientState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  daemonPid: number | null;
  uptime: number;
  tier: string;
  whatsappStatus: WhatsAppConnectionStatus;
  tunnelUrl: string | null;
  sessionToken: string;
  port: number;
}

interface DaemonClientActions {
  /** Execute a task on the daemon */
  executeTask: (taskId: string) => Promise<void>;
  /** Send a chat message to the orchestrator */
  chat: (message: string, channelId?: string) => Promise<string>;
  /** Get WhatsApp status */
  getWhatsAppStatus: () => Promise<{
    status: WhatsAppConnectionStatus;
    phoneNumber: string | null;
    connectionId: string | null;
    allowedChats: unknown[];
  }>;
  /** Start/stop tunnel */
  startTunnel: () => Promise<void>;
  stopTunnel: () => Promise<void>;
  /** Reconnect WebSocket if disconnected */
  reconnect: () => void;
  /** API fetch helper with auth */
  apiFetch: <T = unknown>(path: string, options?: RequestInit) => Promise<T>;
}

export type DaemonClient = DaemonClientState & DaemonClientActions;

/** Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s cap */
const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;
/** Max reconnect attempts before giving up */
const MAX_RECONNECT_ATTEMPTS = 20;

/**
 * Connect to a running daemon via HTTP API + WebSocket.
 */
export function useDaemonClient(port: number, sessionToken: string, dataDir: string): DaemonClient {
  const [state, setState] = useState<DaemonClientState>({
    connected: false,
    connecting: true,
    error: null,
    daemonPid: null,
    uptime: 0,
    tier: 'free',
    whatsappStatus: 'disconnected',
    tunnelUrl: null,
    sessionToken,
    port,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const mountedRef = useRef(true);
  const currentTokenRef = useRef(sessionToken);
  const respawningRef = useRef(false);

  const baseUrl = `http://localhost:${port}`;

  // Authenticated fetch helper — always uses the latest token
  const apiFetch = async <T = unknown>(path: string, options: RequestInit = {}): Promise<T> => {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentTokenRef.current}`,
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  };

  /**
   * Try to re-spawn the daemon after a crash.
   * Returns true if daemon was successfully re-spawned.
   */
  const tryRespawnDaemon = async (): Promise<boolean> => {
    if (respawningRef.current) return false;
    respawningRef.current = true;

    try {
      // Check if daemon process is actually dead
      const { getPidPath } = await import('../../daemon/lifecycle.js');
      const pidPath = getPidPath(dataDir);
      const lock = readLock(pidPath);
      if (lock && isProcessAlive(lock.pid)) {
        // Process is alive, just not responding to WS — don't re-spawn
        return false;
      }

      // Daemon is dead — re-spawn it
      const { fileURLToPath } = await import('url');
      const entryPath = fileURLToPath(new URL('../../index.js', import.meta.url));
      startDaemonBackground(entryPath, port, dataDir);

      const ready = await waitForDaemon(port, 15000);
      if (ready) {
        // Re-read the new token
        const newToken = await getDaemonSessionToken(dataDir);
        if (newToken) {
          currentTokenRef.current = newToken;
          setState(s => ({ ...s, sessionToken: newToken }));
          return true;
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      respawningRef.current = false;
    }
  };

  // Connect WebSocket to receive real-time events
  const connectWs = async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Clear any pending reconnect timer to prevent stacking
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Re-read token from disk in case daemon restarted
    try {
      const freshToken = await getDaemonSessionToken(dataDir);
      if (freshToken && freshToken !== currentTokenRef.current) {
        currentTokenRef.current = freshToken;
        setState(s => ({ ...s, sessionToken: freshToken }));
      }
    } catch {
      // Use existing token
    }

    try {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${currentTokenRef.current}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (mountedRef.current) {
          reconnectAttemptRef.current = 0; // Reset backoff on successful connect
          setState(s => ({ ...s, connected: true, connecting: false, error: null }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type: string; data?: unknown };
          const bus = getEventBus();

          // Forward daemon events to the local EventBus so TUI components react
          if (msg.type && msg.type !== 'pong') {
            bus.emit(msg.type, msg.data);
          }

          // Update local state for key events
          if (msg.type === 'whatsapp:connected') {
            setState(s => ({ ...s, whatsappStatus: 'connected' }));
          } else if (msg.type === 'whatsapp:disconnected') {
            setState(s => ({ ...s, whatsappStatus: 'disconnected' }));
          } else if (msg.type === 'whatsapp:qr') {
            setState(s => ({ ...s, whatsappStatus: 'qr_pending' }));
          } else if (msg.type === 'tunnel:url') {
            setState(s => ({ ...s, tunnelUrl: (msg.data as { url?: string })?.url || null }));
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;

        setState(s => ({ ...s, connected: false }));

        const attempt = reconnectAttemptRef.current;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          setState(s => ({ ...s, error: 'Lost connection to the process. Restart ohwow to reconnect.' }));
          return;
        }

        // Exponential backoff with cap
        const delay = Math.min(BASE_RECONNECT_MS * Math.pow(2, attempt), MAX_RECONNECT_MS);
        reconnectAttemptRef.current = attempt + 1;

        // On first disconnect, try to re-spawn the daemon
        if (attempt === 0) {
          tryRespawnDaemon().then((respawned) => {
            if (mountedRef.current) {
              if (respawned) {
                reconnectAttemptRef.current = 0; // Reset after successful respawn
              }
              connectWs();
            }
          });
          return;
        }

        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connectWs();
        }, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      if (mountedRef.current) {
        setState(s => ({ ...s, connected: false, connecting: false, error: 'WebSocket connection failed' }));
      }
    }
  };

  // Initial connection: verify daemon health, get status, connect WS
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        // Check daemon health
        const healthRes = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
        if (!healthRes.ok) throw new Error('Daemon health check failed');

        // Get daemon status
        try {
          const status = await apiFetch<{ pid: number; uptime: number; tier: string }>(
            '/api/daemon/status',
          );
          if (!cancelled) {
            setState(s => ({
              ...s,
              daemonPid: status.pid,
              uptime: status.uptime,
              tier: status.tier,
            }));
          }
        } catch {
          // daemon/status not available (maybe legacy headless mode), that's OK
        }

        // Connect WebSocket
        if (!cancelled) {
          connectWs();
        }
      } catch (err) {
        if (!cancelled) {
          setState(s => ({
            ...s,
            connecting: false,
            error: err instanceof Error ? err.message : 'Could not connect to the process',
          }));
        }
      }
    };

    init();

    // Register shutdown to clean up WS
    registerShutdown(() => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Actions
  const executeTask = async (taskId: string) => {
    await apiFetch(`/api/tasks/${taskId}/execute`, { method: 'POST' });
  };

  const chat = async (message: string, channelId?: string): Promise<string> => {
    const res = await apiFetch<{ data: { response: string } }>('/api/orchestrator/chat', {
      method: 'POST',
      body: JSON.stringify({ message, channelId }),
    });
    return res.data.response;
  };

  const getWhatsAppStatus = async () => {
    const res = await apiFetch<{ data: { status: WhatsAppConnectionStatus; phoneNumber: string | null; connectionId: string | null; allowedChats: unknown[] } }>(
      '/api/whatsapp/status',
    );
    return res.data;
  };

  const startTunnel = async () => {
    // Tunnel management is handled via daemon config at startup
  };

  const stopTunnel = async () => {
    // Tunnel management via daemon config
  };

  const reconnect = () => {
    reconnectAttemptRef.current = 0;
    wsRef.current?.close();
    connectWs();
  };

  return {
    ...state,
    executeTask,
    chat,
    getWhatsAppStatus,
    startTunnel,
    stopTunnel,
    reconnect,
    apiFetch,
  };
}
