/**
 * Daemon HTTP server phase
 *
 * Constructs the Express app via createServer(), binds the configured port
 * (localhost by default, 0.0.0.0 when OHWOW_HEADLESS=1 or OHWOW_HOST is
 * set), writes the 0o600 session-token file once the bind succeeds, and
 * attaches the WebSocket upgrade handler. Releases the pre-boot
 * instance-lock on EADDRINUSE so a failed start does not strand the PID
 * file.
 *
 * Also registers the daemon-specific status/health/queue/models endpoints
 * that the CLI + dashboard poll for post-boot state. Handlers close over
 * ctx, so they see ctx.tunnel / ctx.controlPlane / ctx.ollamaMonitor /
 * ctx.processMonitor at request time — later boot phases can still populate
 * those fields without any coordination with this one.
 *
 * Populates ctx.app and ctx.server.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { createServer } from '../api/server.js';
import { releaseLock } from '../lib/instance-lock.js';
import { VERSION } from '../version.js';
import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';
import type { InferenceState } from './inference.js';

export async function setupHttpServer(
  ctx: Partial<DaemonContext>,
  inferenceState: InferenceState,
): Promise<void> {
  const { config, db, rawDb, bus, engine, orchestrator, sessionToken, triggerEvaluator, workspaceId, voiceboxService, modelRouter, channelRegistry, messageRouter, controlPlane, startTime, pidPath, dataDir } = ctx as DaemonContext;

  // Gap 13: surface the install-wide cap + explicit/default hint so the
  // per-workspace budget-config route can report source accurately.
  // Explicit = either OHWOW_AUTONOMOUS_SPEND_LIMIT_USD env or the global
  // config.json set it; otherwise loadConfig fell back to 50 USD.
  const envExplicit = (() => {
    const raw = process.env.OHWOW_AUTONOMOUS_SPEND_LIMIT_USD;
    if (!raw) return false;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0;
  })();
  const globalExplicit = envExplicit || (config.autonomousSpendLimitUsd !== 50);

  const { app, attachWs } = createServer({
    config: {
      port: config.port,
      jwtSecret: config.jwtSecret,
      tier: config.tier,
      contentPublicKey: controlPlane?.contentPublicKey ?? undefined,
      dataDir,
      browserHeadless: config.browserHeadless,
      anthropicApiKey: config.anthropicApiKey,
      openRouterApiKey: config.openRouterApiKey,
      licenseKey: config.licenseKey,
      autonomousSpendLimitUsd: config.autonomousSpendLimitUsd,
      autonomousSpendLimitExplicit: globalExplicit,
    },
    db,
    rawDb,
    startTime,
    eventBus: bus,
    engine,
    orchestrator,
    sessionToken,
    triggerEvaluator,
    workspaceId,
    voiceboxService,
    modelRouter,
    getWhatsAppClient: () => ctx.waClient ?? null,
    channelRegistry,
    messageRouter: messageRouter ?? undefined,
    controlPlane,
    onScheduleChange: () => ctx.scheduler?.notify(),
    ragConfig: {
      ollamaUrl: config.ollamaUrl,
      ollamaModel: config.ollamaModel,
      ragBm25Weight: config.ragBm25Weight,
      rerankerEnabled: config.rerankerEnabled,
    },
  });

  // Bind port — only write PID lock and token AFTER successful bind
  // In headless/Docker mode bind to all interfaces; otherwise localhost only (security default)
  const host = process.env.OHWOW_HOST || (process.env.OHWOW_HEADLESS === '1' ? '0.0.0.0' : '127.0.0.1');
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const srv = app.listen(config.port, host, () => {
      logger.info(`[daemon] HTTP server on ${host}:${config.port}`);
      logger.info(`[daemon] Health: http://${host === '0.0.0.0' ? 'localhost' : host}:${config.port}/health`);
      resolve(srv);
    });
    srv.on('error', (err: NodeJS.ErrnoException) => {
      // Clean up the pre-check lock since we never fully started
      releaseLock(pidPath);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${config.port} is already in use. ` +
          `Another process may be using it. ` +
          `Set a different port in ~/.ohwow/config.json ("port": 7701) or stop the conflicting process.`
        ));
      } else {
        reject(err);
      }
    });
  });

  // Port bound successfully — now write the token file with restricted permissions
  const tokenPath = join(dataDir, 'daemon.token');
  writeFileSync(tokenPath, sessionToken, { mode: 0o600 });

  attachWs(server);

  // Ollama models endpoint
  app.get('/api/ollama/models', async (_req, res) => {
    if (!ctx.ollamaMonitor) {
      res.json({ data: [] });
      return;
    }
    try {
      const summaries = await ctx.ollamaMonitor.getModelSummaries();
      res.json({ data: summaries });
    } catch {
      res.json({ data: [] });
    }
  });

  // Process statuses + capacity endpoint
  app.get('/api/process-status', (_req, res) => {
    const processMonitor = ctx.processMonitor!;
    const statuses = processMonitor.getStatuses();
    const capacity = processMonitor.estimateCapacity();
    res.json({ statuses, capacity });
  });

  // Consolidated inference status endpoint (provider, VRAM, switch state)
  app.get('/api/inference/status', (_req, res) => {
    const processMonitor = ctx.processMonitor!;
    const capacity = processMonitor.estimateCapacity();
    const mlxRunning = inferenceState.mlxEnabled && !!ctx.mlxManager;
    const llamaCppRunning = !!ctx.llamaCppManager && inferenceState.llamaCppUrl !== undefined;

    res.json({
      activeProvider: mlxRunning ? 'mlx' : llamaCppRunning ? 'llama-cpp' : 'ollama',
      mlx: mlxRunning ? { url: ctx.mlxManager!.getUrl(), model: ctx.mlxManager!.getModel() } : null,
      llamaCpp: llamaCppRunning ? { url: inferenceState.llamaCppUrl } : null,
      switchInProgress: inferenceState.modelSwitchInProgress,
      capacity: {
        totalVramGB: capacity.totalVramGB,
        usedVramGB: capacity.usedVramGB,
        availableVramGB: capacity.availableVramGB,
      },
      processes: processMonitor.getStatuses().filter(s => s.running),
    });
  });

  // Unload the MLX model from GPU memory without killing the server
  app.post('/api/inference/mlx/unload', async (_req, res) => {
    if (!ctx.mlxManager) {
      res.status(404).json({ error: 'MLX server not running' });
      return;
    }
    try {
      await ctx.mlxManager.unloadModel();
      inferenceState.dedicatedServerVramGB = 0;
      ctx.processMonitor!.unregisterExternalProcess('mlx');
      bus.emit('inference:capabilities-changed', (await import('../lib/inference-capabilities.js')).createDefaultCapabilities());
      res.json({ data: { unloaded: true } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unload failed' });
    }
  });

  // TurboQuant capabilities endpoint
  app.get('/api/turboquant/status', (_req, res) => {
    const caps = ctx.mlxManager?.getCapabilities() ?? ctx.llamaCppManager?.getCapabilities() ?? null;
    res.json({
      active: caps?.turboQuantActive ?? false,
      bits: caps?.turboQuantBits ?? 0,
      cacheTypeK: caps?.cacheTypeK ?? null,
      cacheTypeV: caps?.cacheTypeV ?? null,
      provider: caps?.provider ?? 'ollama',
      llamaServerRunning: ctx.llamaCppManager ? true : false,
      mlxServerRunning: ctx.mlxManager ? true : false,
      mlxModel: ctx.mlxManager?.getModel() ?? null,
    });
  });

  // Queue status endpoint (used by auto-updater to wait for active tasks)
  app.get('/api/daemon/queue-status', (_req, res) => {
    const status = engine.getQueueStatus();
    res.json({ active: status.active, waiting: status.waiting });
  });

  // Daemon-specific status endpoint — reads late-populated ctx fields
  // (tunnel, controlPlane) at request time.
  app.get('/api/daemon/status', (_req, res) => {
    const orchestratorSetting = rawDb.prepare(
      "SELECT value FROM runtime_settings WHERE key = 'orchestrator_model'"
    ).get() as { value: string } | undefined;
    const orchestratorModel = orchestratorSetting?.value || config.orchestratorModel || null;
    res.json({
      pid: process.pid,
      uptime: Math.round((Date.now() - startTime) / 1000),
      version: VERSION,
      port: config.port,
      tier: config.tier,
      workspaceId,
      cloudConnected: !!ctx.controlPlane?.connectedWorkspaceId,
      ollamaConnected: inferenceState.ollamaStatus,
      ollamaAutoStartFailed: inferenceState.ollamaAutoStartFailed,
      ollamaModel: config.ollamaModel,
      orchestratorModel,
      modelReady: inferenceState.ollamaStatus || config.modelSource === 'cloud' || !!config.anthropicApiKey || !!config.openRouterApiKey,
      tunnelUrl: ctx.tunnel?.url || null,
      cloudWebhookBaseUrl: ctx.controlPlane?.connectedWorkspaceId
        ? `${config.cloudUrl}/hooks/${ctx.controlPlane.connectedWorkspaceId}`
        : null,
      deviceId: ctx.controlPlane?.connectedDeviceId || null,
    });
  });

  ctx.app = app;
  ctx.server = server;
}
