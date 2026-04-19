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
import { consolidateWorkspace, startCloudPolling } from './cloud.js';
import { setupOrchestration } from './orchestration.js';
import { setupHttpServer } from './http.js';
import { initializeMessagingChannels } from './channels.js';
import { initializeScheduling } from './scheduling.js';
import { initializePeersAndDocuments } from './peers.js';
import { setupOptionalIntegrations } from './extras.js';
import { createShutdownHandler } from './shutdown.js';
import { wireConductor } from '../autonomy/wire-daemon.js';
import { resolveActiveWorkspace, workspaceLayoutFor } from '../config.js';
import { getSharedEmbedder, warmSharedEmbedder } from '../embeddings/singleton.js';
import { runEmbeddingBackfill } from '../embeddings/backfill.js';
import { createEmbedRouter } from '../api/routes/embed.js';
import { WorkspaceRegistry, discoverWorkspaceNames } from './workspace-registry.js';
import type { WorkspaceContext } from './workspace-context.js';
import { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';

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

  // 6b. Build workspace registry — discover all initialised workspaces and
  // create a lightweight WorkspaceContext for each. The primary workspace
  // context is built from the already-initialised ctx fields; secondary
  // workspaces get their own SQLite connection and event bus but start
  // with controlPlane=null (Phase 2 constraint — cloud connect runs for
  // primary only). acquireLock is NOT called for secondary workspaces since
  // the PID file is per-daemon, not per-workspace.
  const registry = new WorkspaceRegistry();
  ctx.registry = registry;

  const primaryName = ctx.workspaceName;
  const allWorkspaceNames = discoverWorkspaceNames();

  // Register primary workspace context using the already-initialised fields.
  const primaryWsCtx: WorkspaceContext = {
    workspaceName: primaryName,
    workspaceId: 'local', // will be updated post-cloud consolidation externally
    dataDir: ctx.dataDir,
    sessionToken: ctx.sessionToken,
    rawDb: ctx.rawDb,
    db: ctx.db,
    config: ctx.config,
    businessContext: ctx.businessContext,
    engine: null,   // populated after createEngine
    orchestrator: null,
    triggerEvaluator: null,
    channelRegistry: null,
    connectorRegistry: null,
    messageRouter: null,
    scheduler: null,
    proactiveEngine: null,
    connectorSyncScheduler: null,
    controlPlane: null, // populated after connectCloudAndConsolidate
    bus: ctx.bus,
  };
  registry.register(primaryWsCtx);

  // Register secondary workspaces (all except primary)
  for (const wsName of allWorkspaceNames) {
    if (wsName === primaryName) continue; // already registered above
    try {
      const { TypedEventBus } = await import('../lib/typed-event-bus.js');
      const { initDatabase } = await import('../db/init.js');
      const { createSqliteAdapter } = await import('../db/sqlite-adapter.js');
      const { createRpcHandlers } = await import('../db/rpc-handlers.js');
      const { signDaemonToken, verifyDaemonToken } = await import('./token-codec.js');
      const { existsSync: fsExistsSync, readFileSync: fsReadFileSync, writeFileSync: fsWriteFileSync } = await import('fs');
      const { join: pathJoin } = await import('path');
      const { randomUUID } = await import('crypto');

      const layout = workspaceLayoutFor(wsName);

      // Initialise per-workspace SQLite
      const wsRawDb = initDatabase(layout.dbPath);
      const wsRpcHandlers = createRpcHandlers(wsRawDb);
      const wsDb = createSqliteAdapter(wsRawDb, { rpcHandlers: wsRpcHandlers });

      // Per-workspace event bus (must not be shared between workspaces)
      const wsBus = new TypedEventBus<RuntimeEvents>();

      // Reuse or mint session token for this workspace
      const tokenPath = pathJoin(layout.dataDir, 'daemon.token');
      let wsSessionToken: string | null = null;
      if (fsExistsSync(tokenPath)) {
        try {
          const existing = fsReadFileSync(tokenPath, 'utf8').trim();
          if (existing && ctx.config.jwtSecret) {
            const payload = await verifyDaemonToken(existing, ctx.config.jwtSecret);
            if (payload?.workspaceName === wsName) {
              wsSessionToken = existing;
            }
          } else if (existing) {
            wsSessionToken = existing;
          }
        } catch { /* fall through */ }
      }
      if (!wsSessionToken) {
        if (ctx.config.jwtSecret) {
          wsSessionToken = await signDaemonToken(wsName, ctx.config.jwtSecret);
        } else {
          wsSessionToken = randomUUID();
        }
        try {
          fsWriteFileSync(tokenPath, wsSessionToken, { mode: 0o600 });
        } catch { /* non-fatal */ }
      }

      // Read business context for this workspace
      let wsBusinessContext: import('../execution/types.js').BusinessContext = {
        businessName: 'My Business',
        businessType: 'saas_startup',
      };
      try {
        const row = wsRawDb.prepare(
          'SELECT business_name, business_type FROM agent_workforce_workspaces LIMIT 1',
        ).get() as { business_name: string; business_type: string } | undefined;
        if (row?.business_name) {
          wsBusinessContext = {
            businessName: row.business_name,
            businessType: row.business_type || 'saas_startup',
          };
        }
      } catch { /* table may not exist yet */ }

      // Build workspace config by inheriting the primary config and overriding
      // workspace-specific DB path. Secondary workspaces share global settings
      // but read their own DB file.
      const wsConfig: import('../config.js').RuntimeConfig = {
        ...ctx.config,
        dbPath: layout.dbPath,
      };

      const wsCtx: WorkspaceContext = {
        workspaceName: wsName,
        workspaceId: 'local',
        dataDir: layout.dataDir,
        sessionToken: wsSessionToken,
        rawDb: wsRawDb,
        db: wsDb,
        config: wsConfig,
        businessContext: wsBusinessContext,
        engine: null,
        orchestrator: null,
        triggerEvaluator: null,
        channelRegistry: null,
        connectorRegistry: null,
        messageRouter: null,
        scheduler: null,
        proactiveEngine: null,
        connectorSyncScheduler: null,
        controlPlane: null,
        bus: wsBus,
      };

      registry.register(wsCtx);
      logger.info(`[registry] Loaded secondary workspace '${wsName}'`);
    } catch (err) {
      logger.error({ err }, `[registry] Failed to load workspace '${wsName}' — skipping`);
    }
  }

  // 7. Connect to cloud + consolidate workspace identity for every workspace.
  // Each workspace independently resolves its canonical workspaceId and
  // persists its cloud identity. Non-fatal per workspace: a failure keeps
  // that workspace local-only while others proceed normally.
  for (const wsCtx of ctx.registry!.getAll()) {
    try {
      await consolidateWorkspace(wsCtx);
    } catch (err) {
      logger.error({ err }, `[daemon] Cloud consolidation failed for workspace '${wsCtx.workspaceName}'`);
      // Non-fatal: workspace stays local-only
    }
  }

  // After the loop, sync primary workspace's resolved fields back to ctx
  // for backward compat (callers that read ctx.workspaceId / ctx.controlPlane
  // directly still work, e.g. wireConductor, startCloudPolling).
  // Re-use primaryName declared above (ctx.workspaceName).
  if (ctx.registry!.has(primaryName)) {
    const primaryWs = ctx.registry!.get(primaryName);
    ctx.workspaceId = primaryWs.workspaceId;
    ctx.controlPlane = primaryWs.controlPlane;
    ctx.businessContext = primaryWs.businessContext;
  }

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

  await createEngine(ctx);

  // 9. Start polling (connected tier only)
  startCloudPolling(ctx);

  // 10. Initialize channel registry + orchestrator + digital body
  await setupOrchestration(ctx, inferenceState);

  // 11. Start Express server + WebSocket + register daemon status endpoints
  await setupHttpServer(ctx, inferenceState);

  // 11a. Mount the in-daemon embedder HTTP route on the live app. Kept
  // out of createServer() so the route can live alongside the shared
  // embedder singleton without threading new deps through the server
  // factory. The route is a thin wrapper around getSharedEmbedder() —
  // see src/api/routes/embed.ts.
  ctx.app.use(createEmbedRouter());

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
  // ctx.workspaceId is the cloud-canonical workspace UUID after
  // consolidation; the file mirror needs the on-disk slug, so resolve
  // it separately from the active-workspace pointer / env.
  const activeWorkspace = resolveActiveWorkspace();
  const conductorHandle = wireConductor({
    db: ctx.db,
    workspace_id: ctx.workspaceId,
    workspace_slug: activeWorkspace.name,
    modelRouter: ctx.modelRouter,
  });
  if (conductorHandle) ctx.bus.once('shutdown', () => conductorHandle.stop());

  logger.info('[daemon] Ready');

  // 13d. Fire-and-forget warmup for the in-daemon embedder. The first
  // user-facing embed() call pays a ~30s ONNX cold load on M-series; do
  // it here so the daemon-ready signal fires on time but actual requests
  // hit warm. Failures are logged + swallowed by warmSharedEmbedder.
  void warmSharedEmbedder();

  // 13e. One-shot embedding backfill for knowledge chunks missing a
  // Qwen3 vector. Chains off the same warmup promise so the embedder
  // is already loaded by the time we start scanning. Non-fatal: errors
  // inside runEmbeddingBackfill are caught there, and the outer catch
  // here demotes any surprise rejection to a warn so a broken HF cache
  // or missing table never crashes the daemon.
  void warmSharedEmbedder()
    .then(() => runEmbeddingBackfill({ db: ctx.db, embedder: getSharedEmbedder(), logger }))
    .catch((err) => {
      logger.warn({ err }, '[daemon] embedding backfill skipped (warmup failed)');
    });

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
