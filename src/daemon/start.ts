/**
 * Daemon Entry Point
 * Starts all services (DB, engine, HTTP server, WhatsApp, scheduler, etc.)
 * as a standalone daemon process. No TUI rendering.
 *
 * Usage:
 *   ohwow --daemon    # Foreground daemon (for systemd/launchd/Docker)
 *   Auto-started by TUI when no daemon is detected
 */

import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import { loadConfig, isFirstRun } from '../config.js';
import type { RuntimeConfig } from '../config.js';
import { initDatabase } from '../db/init.js';
import { createSqliteAdapter } from '../db/sqlite-adapter.js';
import { createRpcHandlers } from '../db/rpc-handlers.js';
import { RuntimeEngine } from '../execution/engine.js';
import { createServer } from '../api/server.js';
import { ControlPlaneClient } from '../control-plane/client.js';
import type { AgentConfigPayload } from '../control-plane/types.js';
import type { BusinessContext } from '../execution/types.js';
import { saveWorkspaceData } from '../lib/onboarding-logic.js';
import { WhatsAppClient } from '../whatsapp/client.js';
import { TelegramClient } from '../integrations/telegram/client.js';
import { ChannelRegistry } from '../integrations/channel-registry.js';
import { MessageRouter } from '../integrations/message-router.js';
import { LocalOrchestrator } from '../orchestrator/local-orchestrator.js';
import { ModelRouter } from '../execution/model-router.js';
import { MODEL_CATALOG } from '../lib/ollama-models.js';
import { LocalScheduler } from '../scheduling/local-scheduler.js';
import { ProactiveEngine } from '../planning/proactive-engine.js';
import { LocalTriggerEvaluator } from '../triggers/local-trigger-evaluator.js';
import { ScraplingService } from '../execution/scrapling/index.js';
import { VoiceboxService } from '../voice/voicebox-service.js';
import { DigitalBody, type VoiceServiceLike } from '../body/digital-body.js';
import { DigitalNervousSystem } from '../body/digital-nervous-system.js';
import { OllamaMonitor } from '../lib/ollama-monitor.js';
import { ProcessMonitor } from '../lib/process-monitor.js';
import { acquireLock, releaseLock } from '../lib/instance-lock.js';
import { getPidPath, clearReplacedMarker } from './lifecycle.js';
import { VERSION } from '../version.js';
import type { TunnelResult } from '../tunnel/tunnel.js';
import { logger } from '../lib/logger.js';

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
  const sessionToken = randomUUID();

  // 1. Load config
  let config: RuntimeConfig;
  try {
    config = loadConfig();
  } catch {
    throw new Error('No config found. Run ohwow to complete onboarding first.');
  }

  if (isFirstRun()) {
    throw new Error('Onboarding not complete. Run ohwow to complete onboarding first.');
  }

  const dataDir = dirname(config.dbPath);
  const pidPath = getPidPath(dataDir);

  // 2. Pre-check: is another daemon running? (before binding port)
  if (!acquireLock(pidPath, config.port, VERSION)) {
    throw new Error(`Daemon already running. Check ${pidPath}`);
  }

  const isConnected = config.tier !== 'free';
  const isWorker = config.deviceRole === 'worker';
  // Coordinator role: orchestrator + scheduler + messaging, no local task execution.
  // Task execution filtering happens in the engine, not during daemon init.
  const _isCoordinator = config.deviceRole === 'coordinator';

  logger.info(`[daemon] ohwow v${VERSION} (role: ${config.deviceRole})`);
  logger.info(`[daemon] Tier: ${config.tier}`);
  logger.info(`[daemon] Port: ${config.port}`);
  logger.info(`[daemon] DB: ${config.dbPath}`);

  // 3. Initialize SQLite
  const rawDb = initDatabase(config.dbPath);
  const rpcHandlers = createRpcHandlers(rawDb);
  const db = createSqliteAdapter(rawDb, { rpcHandlers });

  const startTime = Date.now();
  const bus = new TypedEventBus<RuntimeEvents>();

  // 3b. Clean up orphaned tasks/agents from previous crash
  try {
    const now = new Date().toISOString();
    const stuckTasks = rawDb.prepare(
      "UPDATE agent_workforce_tasks SET status = 'failed', error_message = 'Daemon restarted while task was running', completed_at = ?, updated_at = ? WHERE status = 'in_progress'"
    ).run(now, now);
    const stuckAgents = rawDb.prepare(
      "UPDATE agent_workforce_agents SET status = 'idle', updated_at = ? WHERE status = 'working'"
    ).run(now);
    if (stuckTasks.changes > 0 || stuckAgents.changes > 0) {
      logger.info(`[daemon] Recovered ${stuckTasks.changes} orphaned task(s), ${stuckAgents.changes} stuck agent(s)`);
    }
  } catch (err) {
    logger.warn(`[daemon] Orphan cleanup failed: ${err instanceof Error ? err.message : err}`);
  }

  // 4. Read business context from DB
  let businessContext: BusinessContext = {
    businessName: 'My Business',
    businessType: 'saas_startup',
  };
  try {
    const row = rawDb.prepare(
      "SELECT business_name, business_type FROM agent_workforce_workspaces WHERE id = 'local'"
    ).get() as { business_name: string; business_type: string } | undefined;
    if (row?.business_name) {
      businessContext = {
        businessName: row.business_name,
        businessType: row.business_type || 'saas_startup',
      };
    }
  } catch {
    // Table may not exist yet
  }

  // 5. Create ModelRouter
  const mainModelHasVision = MODEL_CATALOG.some(m => m.tag === config.ollamaModel && m.vision);
  // Auto-start llama-server when TurboQuant is enabled for local inference
  let llamaCppUrl: string | undefined;
  let llamaCppManager: import('../lib/llama-cpp-manager.js').LlamaCppManager | null = null;
  let inferenceCapabilities: import('../lib/inference-capabilities.js').InferenceCapabilities | null = null;
  if (config.turboQuantBits > 0 && (config.modelSource === 'local' || config.preferLocalModel)) {
    try {
      const { LlamaCppManager } = await import('../lib/llama-cpp-manager.js');
      const { resolveGgufPath } = await import('../lib/llama-cpp-gguf.js');
      const binaryPath = await LlamaCppManager.ensureBinary(config.llamaCppBinaryPath || undefined);
      const modelPath = await resolveGgufPath(config.ollamaModel, config.llamaCppModelPath || undefined);
      const device = (await import('../lib/device-info.js')).detectDevice();
      const { computeDynamicNumCtx } = await import('../lib/ollama-models.js');
      const contextSize = computeDynamicNumCtx(config.ollamaModel, device, config.turboQuantBits as 2 | 3 | 4);

      llamaCppManager = new LlamaCppManager();
      await llamaCppManager.start({
        binaryPath,
        modelPath,
        contextSize,
        cacheTypeK: LlamaCppManager.cacheTypeFromBits(config.turboQuantBits as 2 | 3 | 4),
        cacheTypeV: LlamaCppManager.cacheTypeFromBits(config.turboQuantBits as 2 | 3 | 4),
        gpuLayers: 99,
        flashAttention: true,
        port: parseInt(new URL(config.llamaCppUrl).port || '8085', 10),
        host: '127.0.0.1',
      });
      llamaCppUrl = llamaCppManager.getUrl();
      inferenceCapabilities = llamaCppManager.getCapabilities();

      // Notify TUI and orchestrator if llama-server crashes and auto-restart fails
      llamaCppManager.setOnCrash(async () => {
        const { createDefaultCapabilities } = await import('../lib/inference-capabilities.js');
        const defaultCaps = createDefaultCapabilities();
        orchestrator?.setInferenceCapabilities(defaultCaps);
        bus.emit('inference:capabilities-changed', defaultCaps);
        logger.warn('[daemon] llama-server permanently down, TurboQuant disabled');
      });

      logger.info({ url: llamaCppUrl, bits: config.turboQuantBits, turboActive: !!inferenceCapabilities?.turboQuantActive }, '[daemon] llama-server started with TurboQuant compression');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[daemon] llama-server not available, falling back to Ollama');
    }
  }

  const modelRouter = new ModelRouter({
    anthropicApiKey: config.anthropicApiKey || undefined,
    ollamaUrl: config.ollamaUrl,
    ollamaModel: config.ollamaModel,
    quickModel: config.quickModel || undefined,
    ocrModel: config.ocrModel || undefined,
    preferLocalModel: config.preferLocalModel,
    modelSource: config.modelSource,
    mainModelHasVision,
    openRouterApiKey: config.openRouterApiKey || undefined,
    openRouterModel: config.openRouterModel || undefined,
    llamaCppUrl,
    turboQuantBits: config.turboQuantBits,
  });

  // Update ModelRouter when user changes active model via the dashboard
  bus.on('ollama:model-changed', (payload: { model: string }) => {
    modelRouter.setOllamaModel(payload.model);
    logger.info(`[daemon] Active Ollama model changed to: ${payload.model}`);

    // Restart llama-server with the new model if TurboQuant is active
    if (llamaCppManager && config.turboQuantBits > 0) {
      (async () => {
        try {
          const { resolveGgufPath } = await import('../lib/llama-cpp-gguf.js');
          const { LlamaCppManager } = await import('../lib/llama-cpp-manager.js');
          const modelPath = await resolveGgufPath(payload.model, config.llamaCppModelPath || undefined);
          const device = (await import('../lib/device-info.js')).detectDevice();
          const { computeDynamicNumCtx } = await import('../lib/ollama-models.js');
          const contextSize = computeDynamicNumCtx(payload.model, device, config.turboQuantBits as 2 | 3 | 4);

          await llamaCppManager!.stop();
          await llamaCppManager!.start({
            binaryPath: config.llamaCppBinaryPath || await LlamaCppManager.ensureBinary(),
            modelPath,
            contextSize,
            cacheTypeK: LlamaCppManager.cacheTypeFromBits(config.turboQuantBits as 2 | 3 | 4),
            cacheTypeV: LlamaCppManager.cacheTypeFromBits(config.turboQuantBits as 2 | 3 | 4),
            gpuLayers: 99,
            flashAttention: true,
            port: parseInt(new URL(config.llamaCppUrl).port || '8085', 10),
            host: '127.0.0.1',
          });

          const caps = llamaCppManager!.getCapabilities();
          if (caps && orchestrator) {
            orchestrator.setInferenceCapabilities(caps);
            bus.emit('inference:capabilities-changed', caps);
          }
          logger.info({ model: payload.model }, '[daemon] llama-server restarted with new model');
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : err, model: payload.model },
            '[daemon] llama-server restart failed for new model, falling back to Ollama');
          const { createDefaultCapabilities } = await import('../lib/inference-capabilities.js');
          const defaultCaps = createDefaultCapabilities();
          if (orchestrator) orchestrator.setInferenceCapabilities(defaultCaps);
          bus.emit('inference:capabilities-changed', defaultCaps);
        }
      })();
    }
  });

  // Update ModelRouter when user changes OpenRouter key or model via the dashboard
  bus.on('openrouter:key-changed', (payload: { key: string }) => {
    modelRouter.setOpenRouterApiKey(payload.key);
    logger.info('[daemon] OpenRouter API key updated');
  });
  bus.on('openrouter:model-changed', (payload: { model: string }) => {
    modelRouter.setOpenRouterModel(payload.model);
    logger.info(`[daemon] OpenRouter model changed to: ${payload.model}`);
  });

  let ollamaStatus = false;
  let ollamaAutoStartFailed = false;
  let warmupAbort: AbortController | null = null;
  if (config.preferLocalModel) {
    let ollamaReady = await modelRouter.isOllamaAvailable();

    // Auto-start Ollama if installed but not running
    if (!ollamaReady) {
      try {
        const { isOllamaInstalled, startOllama } = await import('../lib/ollama-installer.js');
        const installed = await isOllamaInstalled();
        if (installed) {
          await startOllama();
          modelRouter.resetOllamaStatus();
          ollamaReady = await modelRouter.isOllamaAvailable();
        }
      } catch (err) {
        logger.error(`[daemon] Ollama auto-start failed: ${err instanceof Error ? err.message : err}`);
        ollamaAutoStartFailed = true;
      }
    }
    ollamaStatus = ollamaReady;
    logger.info(`[daemon] Ollama: ${ollamaReady ? 'connected' : 'not available'}`);

    // Warm up active model in background (loads into VRAM)
    if (ollamaReady && config.ollamaModel) {
      warmupAbort = new AbortController();
      const timeoutId = setTimeout(() => warmupAbort?.abort(), 120_000);
      fetch(`${config.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.ollamaModel, prompt: ' ', stream: false }),
        signal: warmupAbort.signal,
      })
        .then(() => logger.info(`[daemon] Model ${config.ollamaModel} warmed up`))
        .catch((err: unknown) => {
          if (err instanceof Error && err.name !== 'AbortError') {
            logger.warn(`[daemon] Model warmup failed: ${err.message}`);
          }
        })
        .finally(() => clearTimeout(timeoutId));
    }
  }

  // 5b. Start OllamaMonitor for model tracking (snapshots, usage stats, change events)
  let ollamaMonitor: OllamaMonitor | null = null;
  if (config.preferLocalModel) {
    ollamaMonitor = new OllamaMonitor(config.ollamaUrl, db, bus);
    modelRouter.setOnOllamaResponse((model, inputTokens, outputTokens, durationMs) => {
      ollamaMonitor?.recordUsage(model, inputTokens, outputTokens, durationMs).catch(() => {});
    });
    ollamaMonitor.start();
    logger.info('[daemon] OllamaMonitor started');

    // Reset ModelRouter availability cache when models change
    bus.on('ollama:models-changed', () => {
      modelRouter.resetOllamaStatus();
    });
  }

  // 5c. Start ProcessMonitor for all local AI/media services
  const processMonitor = new ProcessMonitor(config.ollamaUrl, bus);
  processMonitor.start();
  logger.info('[daemon] ProcessMonitor started');

  // 6. Create services
  const scraplingService = new ScraplingService({
    port: config.scraplingPort,
    autoStart: config.scraplingAutoStart,
    proxy: config.scraplingProxy || undefined,
    proxies: config.scraplingProxies.length > 0 ? config.scraplingProxies : undefined,
  });

  const voiceboxService = new VoiceboxService();

  // 7. Connect to cloud (connected tier only)
  let controlPlane: ControlPlaneClient | null = null;
  const engineRef: { current: RuntimeEngine | null } = { current: null };
  const triggerEvaluatorRef: { current: LocalTriggerEvaluator | null } = { current: null };

  // Clear any stale replaced marker unconditionally at daemon startup.
  // If the daemon process starts at all, the marker's job (prevent respawn) is done.
  // This must happen before cloud connect — if connect fails, the marker would persist.
  clearReplacedMarker(dataDir);

  if (isConnected && config.licenseKey) {
    controlPlane = new ControlPlaneClient(config, db, {
      onTaskDispatch: (agentId, taskId) => {
        if (engineRef.current) {
          logger.info(`[daemon] Task dispatched: ${taskId} -> agent ${agentId}`);
          engineRef.current.executeTask(agentId, taskId).catch(err => {
            logger.error(`[daemon] Task ${taskId} error: ${err instanceof Error ? err.message : err}`);
          });
        }
      },
      onConfigSync: (_agents: AgentConfigPayload[]) => {
        // Config sync handled by control plane
      },
      onTaskCancel: () => {},
      onWorkflowExecute: (workflowId) => {
        if (triggerEvaluatorRef.current) {
          logger.info(`[daemon] Workflow execute: ${workflowId}`);
          triggerEvaluatorRef.current.executeById(workflowId).catch(err => {
            logger.error(`[daemon] Workflow ${workflowId} error: ${err instanceof Error ? err.message : err}`);
          });
        } else {
          logger.warn('[daemon] Workflow execute received but trigger evaluator not ready');
        }
      },
    });

    try {
      const connectResponse = await controlPlane.connect();
      businessContext = connectResponse.businessContext;

      // Store plan name as display-only metadata (cloud knows the real plan)
      if (connectResponse.planTier) {
        (config as { planName: string }).planName = connectResponse.planTier;
        logger.info(`[daemon] Plan: ${connectResponse.planTier}`);
      }

      try {
        await saveWorkspaceData(db, 'local', {
          businessName: businessContext.businessName,
          businessType: businessContext.businessType,
          businessDescription: businessContext.businessDescription || '',
          founderPath: '',
          founderFocus: '',
        });
      } catch (syncErr) {
        logger.warn(`[daemon] Could not sync business data: ${syncErr instanceof Error ? syncErr.message : syncErr}`);
      }

      logger.info(`[daemon] Cloud connected. Workspace: ${connectResponse.workspaceId}`);
    } catch (err) {
      logger.warn(`[daemon] Cloud connect failed (offline mode): ${err instanceof Error ? err.message : err}`);
    }
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

  // 8. Create RuntimeEngine
  const engine = new RuntimeEngine(db, {
    anthropicApiKey: config.anthropicApiKey,
    defaultModel: 'claude-sonnet-4-5',
    maxToolLoopIterations: 25,
    browserHeadless: config.browserHeadless,
    dataDir,
    mcpServers: config.mcpServers,
    claudeCodeCliPath: config.claudeCodeCliPath || undefined,
    claudeCodeCliModel: config.claudeCodeCliModel || undefined,
    claudeCodeCliMaxTurns: config.claudeCodeCliMaxTurns,
    claudeCodeCliPermissionMode: config.claudeCodeCliPermissionMode,
    claudeCodeCliAutodetect: config.claudeCodeCliAutodetect,
    modelSource: config.modelSource,
    daemonPort: config.port,
    daemonToken: sessionToken,
  }, {
    reportToCloud: controlPlane ? (report) => controlPlane!.reportTask(report) : () => Promise.resolve(),
  }, businessContext, bus, modelRouter, scraplingService);
  engineRef.current = engine;

  // 9. Start polling (connected tier only)
  if (controlPlane) {
    controlPlane.startPolling();
    controlPlane.startHeartbeats();
  }

  // 10. Initialize channel registry + orchestrator
  const workspaceId = controlPlane?.connectedWorkspaceId || 'local';
  const channelRegistry = new ChannelRegistry();
  const triggerEvaluator = new LocalTriggerEvaluator(db, engine, workspaceId, channelRegistry);
  triggerEvaluatorRef.current = triggerEvaluator;

  // Workers skip orchestrator/messaging (task execution only)
  const orchestrator = isWorker ? null : new LocalOrchestrator(
    db, engine, workspaceId, config.anthropicApiKey,
    channelRegistry, controlPlane!, modelRouter, scraplingService, config.orchestratorModel, process.cwd(),
    config.browserHeadless, dataDir, config.mcpServers,
  );

  if (orchestrator) {
    orchestrator.setSkipMediaCostConfirmation(config.skipMediaCostConfirmation);
    if (inferenceCapabilities) {
      orchestrator.setInferenceCapabilities(inferenceCapabilities);
      bus.emit('inference:capabilities-changed', inferenceCapabilities);
    }
  }

  // 10b. Bootstrap digital body (Merleau-Ponty: embodiment)
  // Mutable voice state tracker — updated by server.ts when voice sessions start/stop
  const voiceState = { state: 'idle' as 'idle' | 'listening' | 'processing' | 'speaking', stt: null as string | null, tts: null as string | null };
  const voiceAdapter: VoiceServiceLike = {
    isActive: () => voiceState.state !== 'idle',
    getState: () => voiceState.state,
    getSttProvider: () => voiceState.stt,
    getTtsProvider: () => voiceState.tts,
  };

  const digitalBody = new DigitalBody({
    channels: channelRegistry,
    voice: voiceAdapter,
    workingDirectory: process.cwd(),
  });

  const digitalNS = new DigitalNervousSystem({
    body: digitalBody,
    experienceStream: orchestrator?.getBrain()?.experienceStream,
    workspace: orchestrator?.getBrain()?.workspace,
  });
  digitalNS.start();

  // Subscribe to high-salience nervous signals for logging
  digitalNS.onSignal((signal) => {
    if (signal.salience >= 0.5) {
      logger.info({ organ: signal.organId, type: signal.type, salience: signal.salience }, '[body] Nervous signal');
    }
  });

  // Wire body into brain(s) and orchestrator for proprioceptive awareness
  if (orchestrator) {
    orchestrator.getBrain()?.setDigitalBody(digitalBody);
    orchestrator.setDigitalBody(digitalBody);
  }
  engine.getBrain().setDigitalBody(digitalBody);

  logger.info(`[body] Digital body created with ${digitalBody.getOrgans().length} organs, nervous system started`);

  let messageRouter: MessageRouter | null = null;
  if (!isWorker) {
    messageRouter = new MessageRouter({ orchestrator: orchestrator!, channelRegistry, rawDb, triggerEvaluator, eventBus: bus });
  }

  // 11. Start Express server + WebSocket
  let waClient: WhatsAppClient | null = null;
  let scheduler: LocalScheduler | null = null;
  const { app, attachWs } = createServer({
    config: {
      port: config.port,
      jwtSecret: config.jwtSecret,
      tier: config.tier,
      contentPublicKey: controlPlane?.contentPublicKey ?? undefined,
      dataDir,
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
    getWhatsAppClient: () => waClient,
    channelRegistry,
    messageRouter: messageRouter ?? undefined,
    controlPlane,
    onScheduleChange: () => scheduler?.notify(),
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

  // 12. Initialize integrations (all devices — workers relay to primary)
  let tgClient: TelegramClient | null = null;
  let proactiveEngine: ProactiveEngine | null = null;

  // Import relay handler for worker devices (messageRouter is null on workers)
  const { createChannelMessageHandler } = await import('../integrations/relay-handler.js');
  const waMessageHandler = createChannelMessageHandler('whatsapp', messageRouter, db);
  const tgMessageHandler = createChannelMessageHandler('telegram', messageRouter, db);

  {
    // WhatsApp — create one client per connection row (multi-number support)
    const waConnections = rawDb.prepare(
      'SELECT id, label, is_default, auth_state FROM whatsapp_connections WHERE workspace_id = ?',
    ).all(workspaceId) as { id: string; label: string | null; is_default: number; auth_state: string | null }[];

    if (waConnections.length > 0) {
      for (const conn of waConnections) {
        const client = WhatsAppClient.forConnection(rawDb, workspaceId, bus, conn.id, {
          label: conn.label ?? undefined,
          isDefault: conn.is_default === 1,
        });
        channelRegistry.register(client);
        client.setMessageHandler(waMessageHandler);

        if (conn.auth_state) {
          client.connect().then(() => {
            logger.info({ connectionId: conn.id, label: conn.label }, '[daemon] WhatsApp auto-connected');
          }).catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('locked by another device')) {
              logger.info({ connectionId: conn.id }, '[daemon] WhatsApp connection locked by another device, skipping');
            } else {
              logger.warn(`[daemon] WhatsApp auto-connect failed (${conn.label || conn.id}): ${msg}`);
            }
          });
        }
      }
      // Keep waClient pointing to the default/first for backward-compat shutdown
      waClient = channelRegistry.get('whatsapp') as WhatsAppClient | null;
    } else {
      // No connections yet — create a single client (legacy single-instance mode)
      waClient = new WhatsAppClient(rawDb, workspaceId, bus);
      channelRegistry.register(waClient);
      waClient.setMessageHandler(waMessageHandler);
    }

    // Telegram — create one client per connection row (multi-bot support)
    const tgConnections = rawDb.prepare(
      'SELECT id, label, is_default FROM telegram_connections WHERE workspace_id = ?',
    ).all(workspaceId) as { id: string; label: string | null; is_default: number }[];

    if (tgConnections.length > 0) {
      for (const conn of tgConnections) {
        const client = TelegramClient.forConnection(rawDb, workspaceId, bus, conn.id, {
          label: conn.label ?? undefined,
          isDefault: conn.is_default === 1,
        });
        channelRegistry.register(client);
        client.setMessageHandler((connectionId, chatId, sender, text) => {
          tgMessageHandler(connectionId ?? '', chatId, sender, text);
        });

        client.connect().then(() => {
          logger.info({ connectionId: conn.id, label: conn.label }, '[daemon] Telegram auto-connected');
        }).catch(err => {
          logger.warn(`[daemon] Telegram auto-connect failed (${conn.label || conn.id}): ${err instanceof Error ? err.message : err}`);
        });
      }
      tgClient = channelRegistry.get('telegram') as TelegramClient | null;
    } else {
      // No connections yet — create a single client (legacy single-instance mode)
      tgClient = new TelegramClient(rawDb, workspaceId, bus);
      channelRegistry.register(tgClient);
      tgClient.setMessageHandler((connectionId, chatId, sender, text) => {
        tgMessageHandler(connectionId ?? '', chatId, sender, text);
      });

      if (tgClient.isConfigured()) {
        tgClient.connect().then(() => {
          logger.info('[daemon] Telegram auto-connected');
        }).catch(err => {
          logger.warn(`[daemon] Telegram auto-connect failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    }
  }

  // Scheduler and proactive engine: primary only (workers skip)
  if (!isWorker) {
    // Scheduler
    scheduler = new LocalScheduler(db, engine, workspaceId);
    scheduler.setTriggerEvaluator(triggerEvaluator);
    scheduler.start().catch(err => {
      logger.warn(`[daemon] Scheduler failed: ${err instanceof Error ? err.message : err}`);
    });

    // Wire schedule change notifications to orchestrator
    if (orchestrator) {
      orchestrator.setScheduleChangeCallback(() => scheduler?.notify());
    }

    // Proactive engine
    proactiveEngine = new ProactiveEngine(db, workspaceId, bus);
    proactiveEngine.start().catch(err => {
      logger.warn(`[daemon] Proactive engine failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  // 12b. Start peer discovery + monitoring (all devices including workers)
  let peerDiscovery: import('../peers/discovery.js').PeerDiscovery | null = null;
  let peerMonitor: import('../peers/peer-monitor.js').PeerMonitor | null = null;
  {
    try {
      const { PeerDiscovery } = await import('../peers/discovery.js');
      const { PeerMonitor } = await import('../peers/peer-monitor.js');
      const { getMachineId } = await import('../lib/machine-id.js');
      const { detectDevice, getMemoryTier } = await import('../lib/device-info.js');

      const device = detectDevice();
      const memoryTier = getMemoryTier(device);

      // Get workspace name for mDNS advertisement
      const { data: nameSetting } = await db.from('runtime_settings')
        .select('value').eq('key', 'workspace_name').maybeSingle();
      const wsName = (nameSetting as { value: string } | null)?.value || 'workspace';

      peerDiscovery = new PeerDiscovery({
        onPeerFound: (peer) => {
          logger.info(`[daemon] Discovered peer: ${peer.name} at ${peer.url}`);
          bus.emit('peer:discovered', peer);
        },
        onPeerLost: (peer) => {
          logger.info(`[daemon] Lost peer: ${peer.name}`);
          bus.emit('peer:lost', peer);
        },
      });

      // Advertise and browse after server is listening
      const machineId = getMachineId() || 'unknown';
      // Build messaging channels string for peer discovery
      const messagingChannels = channelRegistry.getConnectedTypes().join(',');

      // Collect owned connection IDs for mesh ownership tracking
      const ownedConnectionIds: string[] = [];
      const waConns = rawDb.prepare(
        'SELECT id FROM whatsapp_connections WHERE workspace_id = ?',
      ).all(workspaceId) as { id: string }[];
      for (const c of waConns) ownedConnectionIds.push(c.id);
      const tgConns = rawDb.prepare(
        'SELECT id FROM telegram_connections WHERE workspace_id = ?',
      ).all(workspaceId) as { id: string }[];
      for (const c of tgConns) ownedConnectionIds.push(c.id);

      peerDiscovery.advertise(config.port, {
        name: wsName,
        deviceId: machineId,
        memoryTier,
        version: VERSION,
        deviceRole: config.deviceRole,
        workspaceGroup: config.workspaceGroup,
        messagingChannels,
        ownedConnectionIds: ownedConnectionIds.join(','),
      });
      peerDiscovery.browse();

      // Auto-pair with discovered peers
      bus.on('peer:discovered', async (peer: import('../peers/discovery.js').DiscoveredPeer) => {
        try {
          // Check if already paired (by base_url or deviceId)
          const { data: existing } = await db.from('workspace_peers')
            .select('id, status')
            .eq('base_url', peer.url)
            .maybeSingle();

          if (existing) {
            const row = existing as Record<string, unknown>;
            if (row.status === 'connected') {
              logger.debug(`[daemon] Peer already paired: ${peer.name}`);
              return;
            }
          }

          // Auto-pair via POST to the peer's /api/peers/pair
          const { data: pairNameSetting } = await db.from('runtime_settings')
            .select('value').eq('key', 'workspace_name').maybeSingle();
          const ourName = (pairNameSetting as { value: string } | null)?.value || 'workspace';
          const ourToken = randomUUID();

          const deviceInfo = detectDevice();
          const pairRes = await fetch(`${peer.url}/api/peers/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: ourName,
              callbackUrl: `http://localhost:${config.port}`,
              token: ourToken,
              deviceCapabilities: {
                totalMemoryGb: deviceInfo.totalMemoryGB,
                cpuCores: deviceInfo.cpuCores,
                memoryTier: getMemoryTier(deviceInfo),
                isAppleSilicon: deviceInfo.isAppleSilicon,
                hasNvidiaGpu: deviceInfo.hasNvidiaGpu,
                gpuName: deviceInfo.gpuName,
                deviceRole: config.deviceRole,
              },
              machineId,
            }),
            signal: AbortSignal.timeout(10_000),
          });

          if (!pairRes.ok) {
            logger.warn(`[daemon] Auto-pair with ${peer.name} failed: ${pairRes.status}`);
            return;
          }

          const result = (await pairRes.json()) as {
            name: string;
            peerToken: string;
            deviceCapabilities?: Record<string, unknown>;
            machineId?: string;
          };

          // Build capability fields from response
          const capFields: Record<string, unknown> = {};
          if (result.deviceCapabilities) {
            const dc = result.deviceCapabilities;
            if (dc.totalMemoryGb != null) capFields.total_memory_gb = dc.totalMemoryGb;
            if (dc.cpuCores != null) capFields.cpu_cores = dc.cpuCores;
            if (dc.memoryTier) capFields.memory_tier = dc.memoryTier;
            if (dc.isAppleSilicon != null) capFields.is_apple_silicon = dc.isAppleSilicon ? 1 : 0;
            if (dc.hasNvidiaGpu != null) capFields.has_nvidia_gpu = dc.hasNvidiaGpu ? 1 : 0;
            if (dc.gpuName) capFields.gpu_name = dc.gpuName;
            if (dc.localModels) capFields.local_models = JSON.stringify(dc.localModels);
            if (dc.deviceRole) capFields.device_role = dc.deviceRole;
          }
          if (result.machineId) capFields.machine_id = result.machineId;

          const now = new Date().toISOString();

          if (existing) {
            await db.from('workspace_peers').update({
              name: result.name,
              peer_token: result.peerToken,
              our_token: ourToken,
              status: 'connected',
              last_seen_at: now,
              updated_at: now,
              ...capFields,
            }).eq('id', (existing as Record<string, unknown>).id as string);
          } else {
            await db.from('workspace_peers').insert({
              id: randomUUID(),
              name: result.name,
              base_url: peer.url,
              peer_token: result.peerToken,
              our_token: ourToken,
              status: 'connected',
              capabilities: JSON.stringify({ tasks: true, agents: true, orchestrator: true, activity: true }),
              last_seen_at: now,
              created_at: now,
              updated_at: now,
              ...capFields,
            });
          }

          logger.info(`[daemon] Auto-paired with ${result.name} at ${peer.url}`);
        } catch (err) {
          logger.warn(`[daemon] Auto-pair failed for ${peer.name}: ${err instanceof Error ? err.message : err}`);
        }
      });

      // Update peer status when lost
      bus.on('peer:lost', async (peer: import('../peers/discovery.js').DiscoveredPeer) => {
        try {
          await db.from('workspace_peers')
            .update({ status: 'error', updated_at: new Date().toISOString() })
            .eq('base_url', peer.url);
        } catch (err) {
          logger.debug(`[daemon] Peer status update failed: ${err instanceof Error ? err.message : err}`);
        }
      });

      // Activate MeshCoordinator for leader election + connection ownership
      const { MeshCoordinator } = await import('../peers/mesh-coordinator.js');
      const meshCoordinator = new MeshCoordinator(machineId);

      // Register our own connections
      meshCoordinator.registerOwnedConnections(machineId, ownedConnectionIds);

      // Start automatic health checks (with mesh coordinator for failover)
      peerMonitor = new PeerMonitor(db, bus, meshCoordinator);
      peerMonitor.start();

      // Wire failover: when a peer with connections goes offline, try to take over
      bus.on('peer:failover', async (event: { peerId: string; machineId: string; connectionIds: string[] }) => {
        const { fetchAndImportAuthState } = await import('../whatsapp/auth-state.js');
        const { acquireConnectionLock } = await import('../whatsapp/auth-state.js');

        for (const connId of event.connectionIds) {
          try {
            // Try to acquire the lock (it should be expired since the peer is dead)
            const lockAcquired = acquireConnectionLock(rawDb, connId, machineId);
            if (!lockAcquired) {
              logger.info({ connectionId: connId }, '[daemon] Failover: connection lock held by another device');
              continue;
            }

            // Try to fetch auth state from the dead peer (best effort)
            const { data: peerRow } = await db.from('workspace_peers').select('*').eq('id', event.peerId).single();
            if (peerRow) {
              const peer = peerRow as Record<string, unknown>;
              const imported = await fetchAndImportAuthState(
                rawDb, peer.base_url as string, peer.our_token as string, connId,
              );
              if (!imported) {
                logger.warn({ connectionId: connId }, '[daemon] Failover: could not import auth state from dead peer');
                continue;
              }
            }

            // Create a new WhatsApp client and connect
            const client = WhatsAppClient.forConnection(rawDb, workspaceId, bus, connId);
            channelRegistry.register(client);
            client.setMessageHandler(waMessageHandler);
            await client.connect();
            logger.info({ connectionId: connId }, '[daemon] Failover: successfully took over connection');
          } catch (err) {
            logger.warn({ connectionId: connId, err }, '[daemon] Failover: failed to take over connection');
          }
        }
      });

      // Wire TaskDistributor for automatic overflow to peers
      const { TaskDistributor } = await import('../peers/task-distributor.js');
      const taskDistributor = new TaskDistributor(db, bus);
      engine.setTaskDistributor(taskDistributor);
      logger.info('[daemon] TaskDistributor enabled for peer overflow');

      // Update mesh state when peers change
      const updateMeshState = async () => {
        const { data: peers } = await db.from('workspace_peers')
          .select('id, name, machine_id, status')
          .eq('status', 'connected');

        meshCoordinator.updatePeers(
          ((peers || []) as Record<string, unknown>[]).map(p => ({
            id: p.id as string,
            name: p.name as string,
            machineId: (p.machine_id as string) || '',
            status: p.status as string,
          }))
        );
        meshCoordinator.logState();

        // Guard singleton services: stop scheduler/proactive on non-primary
        if (!meshCoordinator.isPrimary) {
          if (scheduler?.isRunning) {
            scheduler.stop();
            logger.info('[daemon] Scheduler stopped (not primary)');
          }
          if (proactiveEngine?.isRunning) {
            proactiveEngine.stop();
            logger.info('[daemon] Proactive engine stopped (not primary)');
          }
        } else {
          // Re-start singletons if we became primary
          if (scheduler && !scheduler.isRunning) {
            scheduler.start().catch(err => {
              logger.warn(`[daemon] Scheduler restart failed: ${err instanceof Error ? err.message : err}`);
            });
            logger.info('[daemon] Scheduler restarted (became primary)');
          }
          if (proactiveEngine && !proactiveEngine.isRunning) {
            proactiveEngine.start().catch(err => {
              logger.warn(`[daemon] Proactive engine restart failed: ${err instanceof Error ? err.message : err}`);
            });
            logger.info('[daemon] Proactive engine restarted (became primary)');
          }
        }
      };

      bus.on('peer:discovered', () => setTimeout(updateMeshState, 2000));
      bus.on('peer:lost', () => setTimeout(updateMeshState, 1000));

      // Start cross-device message history sync
      const { MessageSync } = await import('../peers/message-sync.js');
      const messageSync = new MessageSync(db, rawDb);
      messageSync.start();

      // Add to shutdown cleanup
      bus.once('shutdown', () => messageSync.stop());
    } catch (err) {
      logger.warn(`[daemon] Peer discovery failed to start: ${err instanceof Error ? err.message : err}`);
    }
  }

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

  // Ollama models endpoint
  app.get('/api/ollama/models', async (_req, res) => {
    if (!ollamaMonitor) {
      res.json({ data: [] });
      return;
    }
    try {
      const summaries = await ollamaMonitor.getModelSummaries();
      res.json({ data: summaries });
    } catch {
      res.json({ data: [] });
    }
  });

  // Process statuses + capacity endpoint
  app.get('/api/process-status', (_req, res) => {
    const statuses = processMonitor.getStatuses();
    const capacity = processMonitor.estimateCapacity();
    res.json({ statuses, capacity });
  });

  // TurboQuant capabilities endpoint
  app.get('/api/turboquant/status', (_req, res) => {
    const caps = llamaCppManager?.getCapabilities() ?? null;
    res.json({
      active: caps?.turboQuantActive ?? false,
      bits: caps?.turboQuantBits ?? 0,
      cacheTypeK: caps?.cacheTypeK ?? null,
      cacheTypeV: caps?.cacheTypeV ?? null,
      provider: caps?.provider ?? 'ollama',
      llamaServerRunning: llamaCppManager ? true : false,
    });
  });

  // Queue status endpoint (used by auto-updater to wait for active tasks)
  app.get('/api/daemon/queue-status', (_req, res) => {
    const status = engine.getQueueStatus();
    res.json({ active: status.active, waiting: status.waiting });
  });

  // Add daemon-specific status endpoint (after all services initialized)
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
      cloudConnected: !!controlPlane?.connectedWorkspaceId,
      ollamaConnected: ollamaStatus,
      ollamaAutoStartFailed,
      ollamaModel: config.ollamaModel,
      orchestratorModel,
      modelReady: ollamaStatus,
      tunnelUrl: tunnel?.url || null,
      cloudWebhookBaseUrl: controlPlane?.connectedWorkspaceId
        ? `${config.cloudUrl}/hooks/${controlPlane.connectedWorkspaceId}`
        : null,
      deviceId: controlPlane?.connectedDeviceId || null,
    });
  });

  logger.info('[daemon] Ready');

  // 14. Shutdown handler (defined before route so it can be referenced)
  const shutdown = () => {
    logger.info('\n[daemon] Shutting down...');
    warmupAbort?.abort();
    engine.drainQueue('Daemon shutting down');
    orchestrator?.closeBrowser().catch(() => {});
    orchestrator?.closeDesktop().catch(() => {});
    orchestrator?.closeMcp().catch(() => {});
    llamaCppManager?.stop().catch(() => {});
    ollamaMonitor?.stop();
    processMonitor.stop();
    tunnel?.stop();
    scheduler?.stop();
    proactiveEngine?.stop();
    scraplingService.stop().catch(() => {});
    voiceboxService.stop().catch(() => {});
    digitalNS.stop();
    tgClient?.disconnect();
    waClient?.disconnect();
    peerDiscovery?.stop();
    peerMonitor?.stop();
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
