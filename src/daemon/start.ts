/**
 * Daemon Entry Point
 * Starts all services (DB, engine, HTTP server, WhatsApp, scheduler, etc.)
 * as a standalone daemon process. No TUI rendering.
 *
 * Usage:
 *   ohwow --daemon    # Foreground daemon (for systemd/launchd/Docker)
 *   Auto-started by TUI when no daemon is detected
 */

import { migrateLegacyDataDirIfNeeded } from './migrate-legacy.js';
import { logger } from '../lib/logger.js';
import { createEmptyContext, type DaemonContext } from './context.js';
import { initDaemon, createServices, createEngine } from './init.js';
import { setupInference } from './inference.js';
import { connectCloudAndConsolidate, startCloudPolling } from './cloud.js';
import { setupOrchestration } from './orchestration.js';
import { setupHttpServer } from './http.js';
import { initializeMessagingChannels } from './channels.js';
import { initializeScheduling } from './scheduling.js';
import { initializePeersAndDocuments } from './peers.js';
import { setupOptionalIntegrations } from './extras.js';
import { createShutdownHandler } from './shutdown.js';
import { wireConductor } from '../autonomy/wire-daemon.js';

export interface DaemonHandle {
  shutdown: () => void;
  port: number;
  sessionToken: string;
}

/**
 * Start the daemon: initialize all services, start HTTP + WS server.
 * Writes PID and session token files for client discovery.
 */
export async function startDaemon(): Promise<DaemonHandle> {
  // 0. One-shot legacy data dir migration. Must run before loadConfig() so
  // the resolver returns the post-migration paths. Throws if a stray daemon
  // is still alive on the legacy PID file.
  migrateLegacyDataDirIfNeeded();

  const ctx = createEmptyContext() as DaemonContext;
  await initDaemon(ctx);

  const { config, sessionToken } = ctx;

  const inferenceState = await setupInference(ctx);

  createServices(ctx);

  // 7. Connect to cloud + consolidate workspace identity
  await connectCloudAndConsolidate(ctx);

  // 7.5 Detect Claude Code CLI availability
  if (config.claudeCodeCliAutodetect) {
    try {
      const { detectClaudeCode } = await import('../execution/adapters/claude-code-detection.js');
      const ccStatus = await detectClaudeCode(config.claudeCodeCliPath || undefined);
      if (ccStatus.available) {
        logger.info({ version: ccStatus.version, path: ccStatus.binaryPath }, '[daemon] Claude Code CLI detected');
      }
    } catch (err) {
      logger.debug({ err }, '[daemon] Claude Code CLI detection failed (non-fatal)');
    }
  }

  createEngine(ctx);

  // 9. Start polling (connected tier only)
  startCloudPolling(ctx);

  // 10. Initialize channel registry + orchestrator + digital body
  await setupOrchestration(ctx, inferenceState);

  // 11. Start Express server + WebSocket + register daemon status endpoints
  await setupHttpServer(ctx, inferenceState);

  // 12. Initialize messaging channels (WhatsApp + Telegram auto-connect)
  await initializeMessagingChannels(ctx);

  // 12a. Scheduling + self-bench (primary only)
  await initializeScheduling(ctx);

  // 12a2. Document processing + 12b. Peer discovery + mesh
  await initializePeersAndDocuments(ctx);

  // 13. Cloudflare tunnel + 13b. OpenClaw integration
  await setupOptionalIntegrations(ctx);

  // 13c. Autonomy Conductor (Phase 5, dark-launched). No-op unless
  // OHWOW_AUTONOMY_CONDUCTOR=1; ImprovementScheduler runs unchanged.
  const conductorHandle = wireConductor({ db: ctx.db, workspace_id: ctx.workspaceId });
  if (conductorHandle) ctx.bus.once('shutdown', () => conductorHandle.stop());

  logger.info('[daemon] Ready');

  // 14. Shutdown handler (defined before route so it can be referenced)
  const shutdown = createShutdownHandler(ctx);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // HTTP shutdown endpoint for cross-platform graceful stop (Windows lacks SIGTERM)
  ctx.app.post('/shutdown', (_req, res) => {
    res.json({ status: 'shutting_down' });
    shutdown();
  });

  return { shutdown, port: config.port, sessionToken };
}
