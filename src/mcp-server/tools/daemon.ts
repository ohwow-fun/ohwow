/**
 * Daemon Lifecycle MCP Tools
 *
 * Exposes the same stop/start/restart primitives the TUI uses via its
 * `/restart` slash command so that Claude Code (or any MCP client) can
 * restart the ohwow daemon remotely — e.g. after a code change lands in
 * `dist/index.js` and the running daemon needs to pick it up.
 *
 * These tools intentionally go straight to `daemon/lifecycle.ts` rather
 * than through `DaemonApiClient`, because the whole point is that they
 * must work when the daemon is down, misbehaving, or stale.
 */

import { z } from 'zod';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  isDaemonRunning,
  startDaemonBackground,
  stopDaemon,
  waitForDaemon,
  waitForDaemonStop,
} from '../../daemon/lifecycle.js';

interface ResolvedDaemonConfig {
  dataDir: string;
  port: number;
  entryPath: string | null;
}

function resolveConfig(): ResolvedDaemonConfig {
  const configDir = join(homedir(), '.ohwow');
  const dataDir = join(configDir, 'data');

  let port = 7700;
  const configPath = join(configDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      if (typeof config.port === 'number') port = config.port;
    } catch {
      // Fall back to default
    }
  }

  // Entry resolution mirrors the TUI's `/restart` slash command: walk up
  // from this module's compiled location to find `dist/index.js`, then
  // fall back to the sibling `.ts` entry for dev mode.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(thisDir, '..', '..', 'index.js'),     // dist/mcp-server/tools -> dist/index.js
    join(thisDir, '..', '..', '..', 'index.js'),
    join(thisDir, '..', '..', '..', 'index.ts'), // src/mcp-server/tools -> src/index.ts
    join(thisDir, '..', '..', 'index.ts'),
  ];
  const entryPath = candidates.find((p) => existsSync(p)) ?? null;

  return { dataDir, port, entryPath };
}

async function snapshotStatus(
  config: ResolvedDaemonConfig,
): Promise<Record<string, unknown>> {
  const status = await isDaemonRunning(config.dataDir, config.port);
  return {
    running: status.running,
    healthy: status.running && status.healthy !== false,
    pid: status.pid ?? null,
    port: config.port,
    dataDir: config.dataDir,
    entryPath: config.entryPath,
  };
}

export function registerDaemonTools(server: McpServer): void {
  // ohwow_daemon_status — Check if the daemon is running/healthy.
  server.tool(
    'ohwow_daemon_status',
    '[Daemon] Check whether the ohwow local daemon is running. Reports pid, port, health, and the resolved entry path. Does not modify state.',
    {},
    async () => {
      try {
        const config = resolveConfig();
        const status = await snapshotStatus(config);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  // ohwow_daemon_stop — Gracefully stop the running daemon.
  server.tool(
    'ohwow_daemon_stop',
    '[Daemon] Stop the running ohwow daemon gracefully (SIGTERM on Unix, /shutdown on Windows). Returns whether it actually stopped within the timeout.',
    {
      timeoutMs: z
        .number()
        .optional()
        .describe('How long to wait for the daemon to stop before reporting failure. Default 5000ms.'),
    },
    async ({ timeoutMs }) => {
      try {
        const config = resolveConfig();
        const before = await isDaemonRunning(config.dataDir, config.port);
        if (!before.running) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, alreadyStopped: true, ...(await snapshotStatus(config)) }, null, 2) }],
          };
        }

        const sent = await stopDaemon(config.dataDir);
        if (!sent) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Could not send stop signal (permission denied or stale pid)', ...(await snapshotStatus(config)) }, null, 2) }],
            isError: true,
          };
        }

        const stopped = await waitForDaemonStop(config.dataDir, timeoutMs ?? 5000);
        const after = await snapshotStatus(config);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: stopped, ...after }, null, 2) }],
          isError: !stopped,
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  // ohwow_daemon_start — Start the daemon if it's not already running.
  server.tool(
    'ohwow_daemon_start',
    '[Daemon] Start the ohwow daemon in the background if it is not already running. Waits for the health endpoint before returning. No-op if the daemon is already healthy.',
    {
      timeoutMs: z
        .number()
        .optional()
        .describe('How long to wait for the daemon to become healthy. Default 15000ms.'),
    },
    async ({ timeoutMs }) => {
      try {
        const config = resolveConfig();
        const before = await isDaemonRunning(config.dataDir, config.port);
        if (before.running && before.healthy !== false) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, alreadyRunning: true, ...(await snapshotStatus(config)) }, null, 2) }],
          };
        }
        if (!config.entryPath) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Could not locate daemon entry (dist/index.js or src/index.ts)', ...(await snapshotStatus(config)) }, null, 2) }],
            isError: true,
          };
        }

        const spawnedPid = startDaemonBackground(config.entryPath, config.port, config.dataDir);
        const ready = await waitForDaemon(config.port, timeoutMs ?? 15000);
        const after = await snapshotStatus(config);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: ready, spawnedPid, entryPath: config.entryPath, ...after }, null, 2),
          }],
          isError: !ready,
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  // ohwow_daemon_restart — Full stop + start cycle.
  server.tool(
    'ohwow_daemon_restart',
    '[Daemon] Restart the ohwow daemon: stop if running, wait for the PID to clear, then spawn a fresh background instance and wait for health. Use this after rebuilding dist/index.js so the running daemon picks up the new code. Safe to call even when the daemon is already dead — it will just start a fresh one.',
    {
      stopTimeoutMs: z
        .number()
        .optional()
        .describe('Timeout for the stop phase. Default 5000ms.'),
      startTimeoutMs: z
        .number()
        .optional()
        .describe('Timeout for the start/health phase. Default 15000ms.'),
    },
    async ({ stopTimeoutMs, startTimeoutMs }) => {
      try {
        const config = resolveConfig();
        if (!config.entryPath) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Could not locate daemon entry (dist/index.js or src/index.ts)', ...(await snapshotStatus(config)) }, null, 2) }],
            isError: true,
          };
        }

        const before = await isDaemonRunning(config.dataDir, config.port);
        const phases: Record<string, unknown> = {
          wasRunning: before.running,
          previousPid: before.pid ?? null,
        };

        if (before.running) {
          const sent = await stopDaemon(config.dataDir);
          phases.stopSignalSent = sent;
          if (!sent) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, phase: 'stop', error: 'Could not send stop signal', ...phases, ...(await snapshotStatus(config)) }, null, 2) }],
              isError: true,
            };
          }
          const stopped = await waitForDaemonStop(config.dataDir, stopTimeoutMs ?? 5000);
          phases.stopped = stopped;
          if (!stopped) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, phase: 'stop', error: 'Previous daemon did not exit within timeout', ...phases, ...(await snapshotStatus(config)) }, null, 2) }],
              isError: true,
            };
          }
        }

        const spawnedPid = startDaemonBackground(config.entryPath, config.port, config.dataDir);
        phases.spawnedPid = spawnedPid;
        const ready = await waitForDaemon(config.port, startTimeoutMs ?? 15000);
        phases.ready = ready;

        const after = await snapshotStatus(config);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: ready, phase: ready ? 'ready' : 'start', ...phases, ...after }, null, 2),
          }],
          isError: !ready,
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );
}
