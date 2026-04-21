/**
 * useRuntime Hook
 * Connects TUI to the daemon as an HTTP/WS client.
 * The TUI keeps a local read-only SQLite connection for displaying lists.
 * Write operations go through the daemon HTTP API.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { logger } from '../../lib/logger.js';
import type { RuntimeConfig } from '../../config.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { getEventBus } from './use-event-bus.js';
import type { WhatsAppConnectionStatus } from '../../whatsapp/types.js';
import type Database from 'better-sqlite3';
import { registerShutdown } from './shutdown-registry.js';
import { isDaemonRunning, startDaemonBackground, waitForDaemon, waitForDaemonStop, getDaemonSessionToken, stopDaemon, getLogPath } from '../../daemon/lifecycle.js';
import { readFileSync } from 'fs';
import { VERSION } from '../../version.js';
import { readLock } from '../../lib/instance-lock.js';

interface DaemonStatusResponse {
  pid: number;
  uptime: number;
  version: string;
  port: number;
  tier: string;
  workspaceId: string;
  cloudConnected: boolean;
  ollamaConnected: boolean;
  ollamaModel: string;
  orchestratorModel: string | null;
  modelReady: boolean;
  tunnelUrl: string | null;
  cloudWebhookBaseUrl: string | null;
}

export interface RuntimeState {
  // Read-only DB for display hooks
  db: DatabaseAdapter;
  rawDb: Database.Database;
  // Daemon connection
  daemonMode: boolean;
  daemonPort: number | null;
  sessionToken: string;
  // Status from daemon
  cloudConnected: boolean;
  workspaceId: string;
  ollamaConnected: boolean;
  ollamaModel: string;
  orchestratorModel: string;
  modelReady: boolean;
  whatsappStatus: WhatsAppConnectionStatus;
  tunnelUrl: string | null;
  cloudWebhookBaseUrl: string | null;
  // Daemon info
  daemonPid: number | null;
  daemonUptime: number;
  daemonConnectedAt: number | null;
  // Lifecycle
  initializing: boolean;
  error: string | null;
  shutdown: () => void;
  refreshStatus: () => Promise<void>;
}

interface RuntimeDeps {
  config: RuntimeConfig;
  db: DatabaseAdapter;
  rawDb: Database.Database;
}

/** Read the daemon log and extract the most relevant error message. */
function readDaemonError(dataDir: string): string | null {
  try {
    const logPath = getLogPath(dataDir);
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    const tail = lines.slice(-30);

    // Scan for known error patterns (most specific first)
    const errorPatterns = [
      /EADDRINUSE.*?(\d+)/,
      /Port (\d+) is already in use/i,
      /No config found/i,
      /EACCES/,
      /ENOSPC/,
      /Cannot find module/,
      /Error: (.+)/,
      /uncaught exception: (.+)/i,
      /fatal/i,
    ];

    for (const line of tail.reverse()) {
      for (const pattern of errorPatterns) {
        const match = line.match(pattern);
        if (match) {
          // For EADDRINUSE, return a friendly message
          if (pattern.source.includes('EADDRINUSE')) {
            return `Port ${match[1]} is already in use.`;
          }
          // Return the matched portion, trimmed
          return (match[1] || match[0]).trim().slice(0, 200);
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function useRuntime({ config, db, rawDb }: RuntimeDeps): RuntimeState {
  const [state, setState] = useState<{
    cloudConnected: boolean;
    workspaceId: string;
    ollamaConnected: boolean;
    ollamaModel: string;
    orchestratorModel: string;
    modelReady: boolean;
    whatsappStatus: WhatsAppConnectionStatus;
    initializing: boolean;
    error: string | null;
    tunnelUrl: string | null;
    cloudWebhookBaseUrl: string | null;
    daemonPid: number | null;
    daemonUptime: number;
    daemonConnectedAt: number | null;
  }>({
    cloudConnected: false,
    workspaceId: 'local',
    ollamaConnected: false,
    ollamaModel: config.ollamaModel || 'qwen3:4b',
    orchestratorModel: config.orchestratorModel || '',
    modelReady: false,
    whatsappStatus: 'disconnected',
    initializing: true,
    error: null,
    tunnelUrl: null,
    cloudWebhookBaseUrl: null,
    daemonPid: null,
    daemonUptime: 0,
    daemonConnectedAt: null,
  });

  const sessionTokenRef = useRef<string>(randomUUID());
  const daemonModeRef = useRef(false);
  const daemonPortRef = useRef<number | null>(config.port);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const init = async () => {
      try {
        const bus = getEventBus();
        const dataDir = dirname(config.dbPath);

        // Helper: connect to daemon as a WS client
        const connectToDaemon = async (daemonToken: string) => {
          daemonModeRef.current = true;
          daemonPortRef.current = config.port;
          sessionTokenRef.current = daemonToken;

          try {
            const ws = new WebSocket(`ws://localhost:${config.port}/ws?token=${daemonToken}`);
            ws.onmessage = (event: MessageEvent) => {
              try {
                const msg = JSON.parse(event.data as string) as { type: string; data?: unknown };
                if (msg.type && msg.type !== 'pong') bus.emit(msg.type, msg.data);
                if (msg.type === 'whatsapp:connected') setState(s => ({ ...s, whatsappStatus: 'connected' as WhatsAppConnectionStatus }));
                else if (msg.type === 'whatsapp:disconnected') setState(s => ({ ...s, whatsappStatus: 'disconnected' as WhatsAppConnectionStatus }));
                else if (msg.type === 'whatsapp:qr') setState(s => ({ ...s, whatsappStatus: 'qr_pending' as WhatsAppConnectionStatus }));
              } catch { /* ignore malformed messages */ }
            };
            ws.onclose = () => {
              bus.emit('daemon:disconnected', {});
            };
            registerShutdown(() => { ws.close(); });
          } catch {
            // WebSocket connect failed, continue with client mode anyway
          }

          // Fetch daemon status to populate runtime state
          try {
            const resp = await fetch(`http://localhost:${config.port}/api/daemon/status`, {
              headers: { Authorization: `Bearer ${daemonToken}` },
              signal: AbortSignal.timeout(5000),
            });
            if (resp.ok) {
              const status = await resp.json() as DaemonStatusResponse;
              setState(s => ({
                ...s,
                initializing: false,
                modelReady: status.modelReady,
                cloudConnected: status.cloudConnected,
                workspaceId: status.workspaceId || 'local',
                ollamaConnected: status.ollamaConnected,
                ollamaModel: status.ollamaModel || s.ollamaModel,
                orchestratorModel: status.orchestratorModel || s.orchestratorModel,
                tunnelUrl: status.tunnelUrl,
                cloudWebhookBaseUrl: status.cloudWebhookBaseUrl,
                daemonPid: status.pid || null,
                daemonUptime: status.uptime || 0,
                daemonConnectedAt: Date.now(),
              }));
            } else {
              setState(s => ({ ...s, initializing: false, modelReady: true }));
            }
          } catch {
            // Status fetch failed, still connected
            setState(s => ({ ...s, initializing: false, modelReady: true }));
          }

          registerShutdown(() => { /* no-op — daemon owns the services */ });
        };

        // Helper: check daemon version and restart if mismatched
        const restartDaemonIfVersionMismatch = async (): Promise<boolean> => {
          const { getPidPath } = await import('../../daemon/lifecycle.js');
          const pidPath = getPidPath(dataDir);
          const lock = readLock(pidPath);
          if (lock?.version && lock.version !== VERSION) {
            logger.info('[TUI] Daemon version mismatch: running v%s, local v%s. Restarting...', lock.version, VERSION);
            await stopDaemon(dataDir);
            await waitForDaemonStop(dataDir, 5000);
            return true;
          }
          return false;
        };

        // 0. Daemon detection: check if a daemon is already running
        try {
          const daemonCheck = await isDaemonRunning(dataDir, config.port);
          if (daemonCheck.running) {
            const restarted = await restartDaemonIfVersionMismatch();
            if (restarted) {
              // Daemon was stopped due to version mismatch — fall through to spawn new one
            } else {
              const daemonToken = await getDaemonSessionToken(dataDir);
              if (daemonToken) {
                await connectToDaemon(daemonToken);
                return;
              }
            }
          }
        } catch {
          // Daemon detection failed — fall through to spawn
        }

        // If no daemon found (or restarted due to version mismatch), try to start one
        try {
          const { dirname, join } = await import('path');
          const { existsSync } = await import('fs');
          const { fileURLToPath } = await import('url');
          const thisDir = dirname(fileURLToPath(import.meta.url));
          const candidates = [
            join(thisDir, 'index.js'),              // Bundled: dist/index.js
            join(thisDir, '..', '..', 'index.js'),  // Unbundled: src/tui/hooks/../../index.js
            join(thisDir, '..', '..', 'index.ts'),  // Unbundled TS (dev mode via tsx): src/index.ts
          ];
          const entryPath = candidates.find(p => existsSync(p));
          if (!entryPath) throw new Error('Could not find daemon entry point');
          startDaemonBackground(entryPath, config.port, dataDir);

          const daemonReady = await waitForDaemon(config.port, 10000);
          if (daemonReady) {
            const daemonToken = await getDaemonSessionToken(dataDir);
            if (daemonToken) {
              await connectToDaemon(daemonToken);
              return;
            }
          }
        } catch (err) {
          // Daemon start failed — fall through to show error
          const spawnError = err instanceof Error ? err.message : null;
          const logError = readDaemonError(dataDir);
          const reason = logError || spawnError || 'Run "ohwow logs" to check for errors.';
          setState(s => ({
            ...s,
            initializing: false,
            error: `Couldn't start the process. ${reason}`,
          }));
          return;
        }

        // Daemon spawned but never became healthy
        const logError = readDaemonError(dataDir);
        const reason = logError || 'Run "ohwow logs" to check for errors.';
        setState(s => ({
          ...s,
          initializing: false,
          error: `Couldn't start the process. ${reason}`,
        }));
      } catch (err) {
        setState(s => ({
          ...s,
          initializing: false,
          error: err instanceof Error ? err.message : 'Couldn\'t start up. Try restarting.',
        }));
      }
    };

    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshStatus = useCallback(async () => {
    const dataDir = dirname(config.dbPath);
    const newToken = await getDaemonSessionToken(dataDir);
    if (newToken) {
      sessionTokenRef.current = newToken;
    }
    const token = sessionTokenRef.current;
    try {
      const resp = await fetch(`http://localhost:${config.port}/api/daemon/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const status = await resp.json() as DaemonStatusResponse;
        setState(s => ({
          ...s,
          modelReady: status.modelReady,
          cloudConnected: status.cloudConnected,
          workspaceId: status.workspaceId || 'local',
          ollamaConnected: status.ollamaConnected,
          ollamaModel: status.ollamaModel || s.ollamaModel,
          orchestratorModel: status.orchestratorModel || s.orchestratorModel,
          tunnelUrl: status.tunnelUrl,
          cloudWebhookBaseUrl: status.cloudWebhookBaseUrl,
          daemonPid: status.pid || null,
          daemonUptime: status.uptime || 0,
          daemonConnectedAt: Date.now(),
          error: null,
        }));
      }
    } catch {
      // Status fetch failed — header stays stale
    }

    // Reconnect WebSocket with (possibly new) token
    try {
      const bus = getEventBus();
      const ws = new WebSocket(`ws://localhost:${config.port}/ws?token=${sessionTokenRef.current}`);
      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as { type: string; data?: unknown };
          if (msg.type && msg.type !== 'pong') bus.emit(msg.type, msg.data);
          if (msg.type === 'whatsapp:connected') setState(s => ({ ...s, whatsappStatus: 'connected' as WhatsAppConnectionStatus }));
          else if (msg.type === 'whatsapp:disconnected') setState(s => ({ ...s, whatsappStatus: 'disconnected' as WhatsAppConnectionStatus }));
          else if (msg.type === 'whatsapp:qr') setState(s => ({ ...s, whatsappStatus: 'qr_pending' as WhatsAppConnectionStatus }));
        } catch { /* ignore malformed messages */ }
      };
      ws.onclose = () => {
        bus.emit('daemon:disconnected', {});
      };
      registerShutdown(() => { ws.close(); });
    } catch {
      // WebSocket reconnect failed
    }
  }, [config.dbPath, config.port]);

  const shutdown = () => {
    // No-op — daemon owns all services. WS cleanup handled by registerShutdown.
  };

  // Poll status until cloudConnected becomes true (control plane may take a few seconds)
  useEffect(() => {
    if (state.cloudConnected || state.initializing) return;
    const interval = setInterval(() => {
      refreshStatus().catch(() => {});
    }, 3000);
    // Stop polling after 30s
    const timeout = setTimeout(() => clearInterval(interval), 30_000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [state.cloudConnected, state.initializing, refreshStatus]);

  return {
    db,
    rawDb,
    daemonMode: daemonModeRef.current,
    daemonPort: daemonPortRef.current,
    sessionToken: sessionTokenRef.current,
    cloudConnected: state.cloudConnected,
    workspaceId: state.workspaceId,
    ollamaConnected: state.ollamaConnected,
    ollamaModel: state.ollamaModel,
    orchestratorModel: state.orchestratorModel,
    modelReady: state.modelReady,
    whatsappStatus: state.whatsappStatus,
    initializing: state.initializing,
    error: state.error,
    tunnelUrl: state.tunnelUrl,
    cloudWebhookBaseUrl: state.cloudWebhookBaseUrl,
    daemonPid: state.daemonPid,
    daemonUptime: state.daemonUptime,
    daemonConnectedAt: state.daemonConnectedAt,
    shutdown,
    refreshStatus,
  };
}
