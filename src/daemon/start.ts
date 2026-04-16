/**
 * Daemon Entry Point
 * Starts all services (DB, engine, HTTP server, WhatsApp, scheduler, etc.)
 * as a standalone daemon process. No TUI rendering.
 *
 * Usage:
 *   ohwow --daemon    # Foreground daemon (for systemd/launchd/Docker)
 *   Auto-started by TUI when no daemon is detected
 */

import { resolveActiveWorkspace } from '../config.js';
import { releaseLock } from '../lib/instance-lock.js';
import type { LocalScheduler } from '../scheduling/local-scheduler.js';
import type { ConnectorSyncScheduler } from '../scheduling/connector-sync-scheduler.js';
import type { ProactiveEngine } from '../planning/proactive-engine.js';
import { getPidPath } from './lifecycle.js';
import { migrateLegacyDataDirIfNeeded } from './migrate-legacy.js';
import type { TunnelResult } from '../tunnel/tunnel.js';
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

  const { config, dataDir, pidPath, rawDb, db, bus, sessionToken, startTime } = ctx;

  const isWorker = config.deviceRole === 'worker';
  // Coordinator role: orchestrator + scheduler + messaging, no local task execution.
  // Task execution filtering happens in the engine, not during daemon init.
  const _isCoordinator = config.deviceRole === 'coordinator';

  const inferenceState = await setupInference(ctx);
  const { modelRouter, mlxManager, llamaCppManager, ollamaMonitor, processMonitor, warmupAbort } = ctx;

  createServices(ctx);
  const { scraplingService, voiceboxService } = ctx;

  // 7. Connect to cloud + consolidate workspace identity
  await connectCloudAndConsolidate(ctx);
  const controlPlane = ctx.controlPlane;
  const workspaceId = ctx.workspaceId!;
  const activeWsName = resolveActiveWorkspace().name;

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
  const engine = ctx.engine!;

  // 9. Start polling (connected tier only)
  startCloudPolling(ctx);

  // 10. Initialize channel registry + orchestrator + digital body
  await setupOrchestration(ctx, inferenceState);
  const { channelRegistry, connectorRegistry, triggerEvaluator, orchestrator, digitalBody, digitalNS, messageRouter, deviceFetcher } = ctx;

  // 11. Start Express server + WebSocket + register daemon status endpoints
  let scheduler: LocalScheduler | null = null;
  let connectorSyncScheduler: ConnectorSyncScheduler | null = null;
  let proactiveEngine: ProactiveEngine | null = null;
  await setupHttpServer(ctx, inferenceState);
  const { app, server } = ctx;

  // 12. Initialize messaging channels (WhatsApp + Telegram auto-connect)
  await initializeMessagingChannels(ctx);
  const { waClient, tgClient } = ctx;

  // 12a. Scheduling + self-bench (primary only)
  await initializeScheduling(ctx);
  scheduler = ctx.scheduler ?? null;
  proactiveEngine = ctx.proactiveEngine ?? null;
  connectorSyncScheduler = ctx.connectorSyncScheduler ?? null;

  // 12a2. Document processing + 12b. Peer discovery + mesh
  await initializePeersAndDocuments(ctx);
  const { documentWorker, peerDiscovery, peerMonitor } = ctx;


  // 13. Cloudflare tunnel (if enabled)
  let tunnel: TunnelResult | null = null;
  if (config.tunnelEnabled) {
    try {
      const { startTunnel } = await import('../tunnel/tunnel.js');
      tunnel = await startTunnel(config.port);

      const { data: existing } = await db.from('runtime_settings')
        .select('key').eq('key', 'tunnel_url').maybeSingle();
      if (existing) {
        await db.from('runtime_settings')
          .update({ value: tunnel.url, updated_at: new Date().toISOString() })
          .eq('key', 'tunnel_url');
      } else {
        await db.from('runtime_settings')
          .insert({ key: 'tunnel_url', value: tunnel.url });
      }

      logger.info(`[daemon] Tunnel: ${tunnel.url}`);
      bus.emit('tunnel:url', tunnel.url);

      if (controlPlane) {
        controlPlane.setTunnelUrl(tunnel.url);
        controlPlane.sendHeartbeatNow().catch(() => {});
      }

      // React to every subsequent URL rotation: update runtime_settings,
      // notify the bus, and push a fresh heartbeat to the control plane so
      // the cloud never keeps calling a dead cloudflared hostname. Without
      // this the runtime appears "disconnected" until the regular 15s
      // heartbeat cycle catches up.
      tunnel.onUrlChange(async (newUrl) => {
        logger.info(`[daemon] Tunnel URL rotated -> ${newUrl}`);
        try {
          await db.from('runtime_settings')
            .update({ value: newUrl, updated_at: new Date().toISOString() })
            .eq('key', 'tunnel_url');
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : err }, '[daemon] persist rotated tunnel URL failed');
        }
        bus.emit('tunnel:url', newUrl);
        if (controlPlane) {
          controlPlane.setTunnelUrl(newUrl);
          controlPlane.sendHeartbeatNow().catch((err) => {
            logger.warn({ err: err instanceof Error ? err.message : err }, '[daemon] immediate heartbeat after tunnel rotation failed');
          });
        }
      });
    } catch (err) {
      logger.warn(`[daemon] Tunnel failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 13b. OpenClaw integration (if enabled)
  if (config.openclaw?.enabled && config.openclaw.binaryPath) {
    try {
      const { buildMcpServerConfig } = await import('../integrations/openclaw/mcp-bridge.js');
      const { registerOpenClawA2ARoutes } = await import('../integrations/openclaw/a2a-bridge.js');

      const openclawMcpConfig = buildMcpServerConfig(config.openclaw);
      config.mcpServers = [...config.mcpServers, openclawMcpConfig];

      registerOpenClawA2ARoutes(app, config.openclaw, config.localUrl);
      logger.info('[daemon] OpenClaw integration enabled');
    } catch (err) {
      logger.warn({ err }, '[daemon] OpenClaw integration setup failed (non-fatal)');
    }
  }

  logger.info('[daemon] Ready');

  // 14. Shutdown handler (defined before route so it can be referenced)
  const shutdown = () => {
    logger.info('\n[daemon] Shutting down...');
    warmupAbort?.abort();
    engine.drainQueue('Daemon shutting down');
    orchestrator?.closeBrowser().catch(() => {});
    // Also tear down the HTTP route's singleton browser service. The cloud
    // routes browser sessions through /browser/session/* which uses its own
    // singleton (separate from the orchestrator's), so without this call any
    // Stagehand-spawned Chromium would survive daemon restart and accumulate
    // as orphaned windows the user has to manually close.
    import('../api/routes/browser-session.js')
      .then(m => m.closeBrowserSessionService())
      .catch(() => {});
    orchestrator?.closeDesktop().catch(() => {});
    orchestrator?.closeMcp().catch(() => {});
    llamaCppManager?.stop().catch(() => {});
    mlxManager?.stop().catch(() => {});
    ollamaMonitor?.stop();
    processMonitor.stop();
    tunnel?.stop();
    scheduler?.stop();
    proactiveEngine?.stop();
    connectorSyncScheduler?.stop();
    documentWorker.stop();
    scraplingService.stop().catch(() => {});
    voiceboxService.stop().catch(() => {});
    digitalNS.stop();
    tgClient?.disconnect();
    waClient?.disconnect();
    peerDiscovery?.stop();
    peerMonitor?.stop();
    deviceFetcher?.destroy();
    // Clean up data-locality timers
    import('../data-locality/approval.js').then(m => m.cancelAllPendingApprovals()).catch(() => {});
    import('../execution/conversation-memory-sync.js').then(m => m.cancelAllExtractionTimers()).catch(() => {});
    bus.emit('shutdown');
    controlPlane?.disconnect();
    server.close(() => {
      rawDb.close();
      releaseLock(getPidPath(dataDir));
      logger.info('[daemon] Stopped');
      process.exit(0);
    });

    setTimeout(() => {
      releaseLock(getPidPath(dataDir));
      process.exit(1);
    }, 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // HTTP shutdown endpoint for cross-platform graceful stop (Windows lacks SIGTERM)
  app.post('/shutdown', (_req, res) => {
    res.json({ status: 'shutting_down' });
    shutdown();
  });

  return { shutdown, port: config.port, sessionToken };
}
