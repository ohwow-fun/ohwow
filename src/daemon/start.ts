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
import {
  loadConfig,
  isFirstRun,
  resolveActiveWorkspace,
  readWorkspaceConfig,
  writeWorkspaceConfig,
  findWorkspaceByCloudId,
} from '../config.js';
import type { RuntimeConfig } from '../config.js';
import { initDatabase } from '../db/init.js';
import { createSqliteAdapter } from '../db/sqlite-adapter.js';
import { createRpcHandlers } from '../db/rpc-handlers.js';
import { RuntimeEngine } from '../execution/engine.js';
import { installDiaryHook } from '../execution/diary-hook.js';
import { createServer } from '../api/server.js';
import { ControlPlaneClient } from '../control-plane/client.js';
import type { AgentConfigPayload } from '../control-plane/types.js';
import type { BusinessContext } from '../execution/types.js';
import { saveWorkspaceData } from '../lib/onboarding-logic.js';
import { WhatsAppClient } from '../whatsapp/client.js';
import { TelegramClient } from '../integrations/telegram/client.js';
import { ChannelRegistry } from '../integrations/channel-registry.js';
import { ConnectorRegistry } from '../integrations/connector-registry.js';
import { GitHubConnector } from '../integrations/connectors/github-connector.js';
import { GoogleDriveConnector } from '../integrations/connectors/google-drive-connector.js';
import { LocalFilesConnector } from '../integrations/connectors/local-files-connector.js';
import { NotionConnector } from '../integrations/connectors/notion-connector.js';
import { MessageRouter } from '../integrations/message-router.js';
import { LocalOrchestrator } from '../orchestrator/local-orchestrator.js';
import { ModelRouter } from '../execution/model-router.js';
import { ExperimentRunner } from '../self-bench/experiment-runner.js';
import { ModelHealthExperiment } from '../self-bench/experiments/model-health.js';
import { TriggerStabilityExperiment } from '../self-bench/experiments/trigger-stability.js';
import { CanaryExperiment } from '../self-bench/experiments/canary-experiment.js';
import { LedgerHealthExperiment } from '../self-bench/experiments/ledger-health.js';
import { StaleTaskCleanupExperiment } from '../self-bench/experiments/stale-task-cleanup.js';
import { StaleTaskThresholdTunerExperiment } from '../self-bench/experiments/stale-threshold-tuner.js';
import { ContentCadenceTunerExperiment } from '../self-bench/experiments/content-cadence-tuner.js';
import { ContentCadenceLoopHealthExperiment } from '../self-bench/experiments/content-cadence-loop-health.js';
import { AdaptiveSchedulerExperiment } from '../self-bench/experiments/adaptive-scheduler.js';
import { AgentCoverageGapExperiment } from '../self-bench/experiments/agent-coverage-gap.js';
import { ExperimentProposalGenerator } from '../self-bench/experiments/experiment-proposal-generator.js';
import { ExperimentAuthorExperiment } from '../self-bench/experiments/experiment-author.js';
import { ListHandlersFuzzExperiment } from '../self-bench/experiments/list-handlers-fuzz.js';
import { HandlerSchemaDriftExperiment } from '../self-bench/experiments/handler-schema-drift.js';
import { ProseInvariantDriftExperiment } from '../self-bench/experiments/prose-invariant-drift.js';
import { AgentOutcomesExperiment } from '../self-bench/experiments/agent-outcomes.js';
import { AutonomousAuthorQualityExperiment } from '../self-bench/experiments/autonomous-author-quality.js';
import { AutonomousPatchRollbackExperiment } from '../self-bench/experiments/autonomous-patch-rollback.js';
import { PatchAuthorExperiment } from '../self-bench/experiments/patch-author.js';
import { FormatDurationFuzzExperiment } from '../self-bench/experiments/format-duration-fuzz.js';
import { TokenSimilarityFuzzExperiment } from '../self-bench/experiments/token-similarity-fuzz.js';
import { StagnationFuzzExperiment } from '../self-bench/experiments/stagnation-fuzz.js';
import { ErrorClassificationFuzzExperiment } from '../self-bench/experiments/error-classification-fuzz.js';
import { SitemapDriftExperiment } from '../self-bench/experiments/sitemap-drift.js';
import { DashboardSmokeExperiment } from '../self-bench/experiments/dashboard-smoke.js';
import { DashboardCopyExperiment } from '../self-bench/experiments/dashboard-copy.js';
import { SourceCopyLintExperiment } from '../self-bench/experiments/source-copy-lint.js';
import { AgentTaskCostWatcherExperiment } from '../self-bench/experiments/agent-cost-watcher.js';
import { ProviderAvailabilityExperiment } from '../self-bench/experiments/provider-availability.js';
import { PatchLoopHealthExperiment } from '../self-bench/experiments/patch-loop-health.js';
import { RoadmapUpdaterExperiment } from '../self-bench/experiments/roadmap-updater.js';
import { RoadmapShapeProbeExperiment } from '../self-bench/experiments/roadmap-shape-probe.js';
import { VitestHealthProbeExperiment } from '../self-bench/experiments/vitest-health-probe.js';
import { LoopCadenceProbeExperiment } from '../self-bench/experiments/loop-cadence-probe.js';
import { TestCoverageProbeExperiment } from '../self-bench/experiments/test-coverage-probe.js';
import { AgentLockContentionExperiment } from '../self-bench/experiments/agent-lock-contention.js';
import { ListCompletenessSummaryExperiment } from '../self-bench/experiments/list-completeness-summary.js';
import {
  refreshRuntimeConfigCache,
  RUNTIME_CONFIG_REFRESH_INTERVAL_MS,
} from '../self-bench/runtime-config.js';
import { setSelfCommitRepoRoot } from '../self-bench/self-commit.js';
import { MODEL_CATALOG } from '../lib/ollama-models.js';
import { LocalScheduler } from '../scheduling/local-scheduler.js';
import { HeartbeatCoordinator } from '../scheduling/heartbeat-coordinator.js';
import { ConnectorSyncScheduler } from '../scheduling/connector-sync-scheduler.js';
import { BusinessVitalsScheduler } from '../scheduling/business-vitals-scheduler.js';
import { LogTailWatcher } from '../scheduling/log-tail-watcher.js';
import { ImprovementScheduler } from '../scheduling/improvement-scheduler.js';
import { ContentCadenceScheduler } from '../scheduling/content-cadence-scheduler.js';
import { SynthesisFailureDetector } from '../scheduling/synthesis-failure-detector.js';
import { SynthesisAutoLearner, isAutoLearningEnabled } from '../scheduling/synthesis-auto-learner.js';
import { RuntimeSkillLoader } from '../orchestrator/runtime-skill-loader.js';
import { InnerThoughtsLoop } from '../presence/inner-thoughts.js';
import { PresenceEngine } from '../presence/presence-engine.js';
import { ConsciousnessBridge } from '../brain/consciousness-bridge.js';
import { ProactiveEngine } from '../planning/proactive-engine.js';
import { LocalTransitionEngine } from '../hexis/transition-engine.js';
import { LocalWorkRouter } from '../hexis/work-router.js';
import { HumanGrowthEngine } from '../hexis/human-growth.js';
import { ObservationEngine } from '../hexis/observation-engine.js';
import { runPersonModelRefinement } from '../lib/person-model-refinement.js';
import { LocalTriggerEvaluator } from '../triggers/local-trigger-evaluator.js';
import { DocumentWorker } from '../execution/workers/document-worker.js';
import { ScraplingService } from '../execution/scrapling/index.js';
import { VoiceboxService } from '../voice/voicebox-service.js';
import { ensureInternetDeps } from '../lib/internet-installer.js';
import { findPythonCommand } from '../lib/platform-utils.js';
import { DigitalBody, type VoiceServiceLike } from '../body/digital-body.js';
import { DigitalNervousSystem } from '../body/digital-nervous-system.js';
import { OllamaMonitor } from '../lib/ollama-monitor.js';
import { ProcessMonitor } from '../lib/process-monitor.js';
import { acquireLock, releaseLock } from '../lib/instance-lock.js';
import { getPidPath, clearReplacedMarker } from './lifecycle.js';
import { migrateLegacyDataDirIfNeeded } from './migrate-legacy.js';
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

  // 0. One-shot legacy data dir migration. Must run before loadConfig() so
  // the resolver returns the post-migration paths. Throws if a stray daemon
  // is still alive on the legacy PID file.
  migrateLegacyDataDirIfNeeded();

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

  // 3b. Clean up orphaned tasks/agents/conversations from previous crash
  try {
    const now = new Date().toISOString();
    const stuckTasks = rawDb.prepare(
      "UPDATE agent_workforce_tasks SET status = 'failed', error_message = 'Daemon restarted while task was running', completed_at = ?, updated_at = ? WHERE status = 'in_progress'"
    ).run(now, now);
    const stuckAgents = rawDb.prepare(
      "UPDATE agent_workforce_agents SET status = 'idle', updated_at = ? WHERE status = 'working'"
    ).run(now);
    // Any 'running' conversation on startup is orphaned: orchestrator messages are
    // buffered in memory across a turn and lost if the daemon exits mid-turn.
    const stuckConvs = rawDb.prepare(
      "UPDATE orchestrator_conversations SET status = 'error', last_error = 'orphaned by daemon restart' WHERE status = 'running'"
    ).run();
    if (stuckTasks.changes > 0 || stuckAgents.changes > 0 || stuckConvs.changes > 0) {
      logger.info(`[daemon] Recovered ${stuckTasks.changes} orphaned task(s), ${stuckAgents.changes} stuck agent(s), ${stuckConvs.changes} orphaned conversation(s)`);
    }
  } catch (err) {
    logger.warn(`[daemon] Orphan cleanup failed: ${err instanceof Error ? err.message : err}`);
  }

  // 4. Read business context from DB.
  // The agent_workforce_workspaces table holds exactly one row per DB file
  // (seeded as 'local' by migration 018, later rewritten to the cloud
  // workspace UUID by the consolidation step below). LIMIT 1 reads the
  // current row regardless of which identity it carries — necessary now that
  // each on-disk workspace has its own DB file.
  let businessContext: BusinessContext = {
    businessName: 'My Business',
    businessType: 'saas_startup',
  };
  try {
    const row = rawDb.prepare(
      'SELECT business_name, business_type FROM agent_workforce_workspaces LIMIT 1'
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

  // Decide which local inference server to run (mutual exclusion: only ONE dedicated server)
  // On Apple Silicon with mlx-vlm: prefer MLX (native Metal, vision/audio)
  // On other hardware with TurboQuant: use llama-cpp
  // Ollama is always available as fallback but we unload its model when a dedicated server starts
  const device = (await import('../lib/device-info.js')).detectDevice();
  const { getMLXModelId, computeDynamicNumCtx } = await import('../lib/ollama-models.js');
  const wantsLocal = config.modelSource === 'local' || config.preferLocalModel;
  const mlxModelId = config.mlxModel || getMLXModelId(config.ollamaModel);
  const useMLX = device.mlxAvailable && !!mlxModelId && (config.mlxEnabled || wantsLocal);
  const useLlamaCpp = !useMLX && config.turboQuantBits > 0 && wantsLocal;

  let llamaCppUrl: string | undefined;
  let llamaCppManager: import('../lib/llama-cpp-manager.js').LlamaCppManager | null = null;
  let inferenceCapabilities: import('../lib/inference-capabilities.js').InferenceCapabilities | null = null;
  let mlxServerUrl: string | undefined;
  let mlxManager: import('../lib/mlx-manager.js').MLXManager | null = null;
  let mlxEnabled = false;
  /** Estimated VRAM used by the dedicated server (for capacity tracking). */
  let dedicatedServerVramGB = 0;

  // Pre-flight: check if model fits in available VRAM (75% of total on Apple Silicon)
  const modelEntry = MODEL_CATALOG.find(m => m.tag === config.ollamaModel);
  const modelSizeGB = modelEntry?.sizeGB ?? 4;
  const totalVramGB = device.isAppleSilicon ? device.totalMemoryGB * 0.75 : (device.hasNvidiaGpu ? 8 : 0);
  const fitsInVram = modelSizeGB < totalVramGB * 0.8; // 80% of available VRAM budget

  if (useMLX && fitsInVram) {
    try {
      const { MLXManager } = await import('../lib/mlx-manager.js');
      mlxManager = new MLXManager();
      const kvBits = config.turboQuantBits > 0 ? config.turboQuantBits as 2 | 3 | 4 : undefined;
      await mlxManager.start({
        pythonPath: device.pythonPath || 'python3',
        model: mlxModelId!,
        port: parseInt(new URL(config.mlxServerUrl).port || '8090', 10),
        host: '127.0.0.1',
        kvBits,
        kvQuantScheme: kvBits ? 'turboquant' : undefined,
      });
      mlxServerUrl = mlxManager.getUrl();
      mlxEnabled = true;
      dedicatedServerVramGB = modelSizeGB;

      if (kvBits) {
        const mlxCaps = mlxManager.getCapabilities();
        if (mlxCaps) inferenceCapabilities = mlxCaps;
      }

      mlxManager.setOnCrash(async () => {
        const { createDefaultCapabilities } = await import('../lib/inference-capabilities.js');
        const defaultCaps = createDefaultCapabilities();
        orchestrator?.setInferenceCapabilities(defaultCaps);
        bus.emit('inference:capabilities-changed', defaultCaps);
        dedicatedServerVramGB = 0;
        logger.warn('[daemon] mlx-vlm server permanently down, MLX disabled');
      });

      // Unload the same model from Ollama to free VRAM (best-effort)
      try {
        const { unloadModel } = await import('../lib/ollama-installer.js');
        await unloadModel(config.ollamaModel, config.ollamaUrl);
      } catch { /* Ollama may not be running or model not loaded */ }

      logger.info({ url: mlxServerUrl, model: mlxModelId, kvBits, provider: 'mlx' }, '[daemon] Started MLX inference (Apple Silicon native)');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[daemon] mlx-vlm not available, falling back to Ollama');
      mlxManager = null;
      mlxEnabled = false;
    }
  } else if (useMLX && !fitsInVram) {
    logger.warn({ modelSizeGB, totalVramGB, model: config.ollamaModel }, '[daemon] Model too large for dedicated MLX server, using Ollama');
  }

  if (useLlamaCpp && !mlxEnabled && fitsInVram) {
    try {
      const { LlamaCppManager } = await import('../lib/llama-cpp-manager.js');
      const { resolveGgufPath } = await import('../lib/llama-cpp-gguf.js');
      const binaryPath = await LlamaCppManager.ensureBinary(config.llamaCppBinaryPath || undefined);
      const modelPath = await resolveGgufPath(config.ollamaModel, config.llamaCppModelPath || undefined);
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
      dedicatedServerVramGB = modelSizeGB;

      llamaCppManager.setOnCrash(async () => {
        const { createDefaultCapabilities } = await import('../lib/inference-capabilities.js');
        const defaultCaps = createDefaultCapabilities();
        orchestrator?.setInferenceCapabilities(defaultCaps);
        bus.emit('inference:capabilities-changed', defaultCaps);
        dedicatedServerVramGB = 0;
        logger.warn('[daemon] llama-server permanently down, TurboQuant disabled');
      });

      // Unload the same model from Ollama to free VRAM (best-effort)
      try {
        const { unloadModel } = await import('../lib/ollama-installer.js');
        await unloadModel(config.ollamaModel, config.ollamaUrl);
      } catch { /* Ollama may not be running or model not loaded */ }

      logger.info({ url: llamaCppUrl, bits: config.turboQuantBits, provider: 'llama-cpp' }, '[daemon] Started llama-server with TurboQuant');
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
    cloudProvider: config.cloudProvider,
    mainModelHasVision,
    openRouterApiKey: config.openRouterApiKey || undefined,
    openRouterModel: config.openRouterModel || undefined,
    llamaCppUrl,
    turboQuantBits: config.turboQuantBits,
    mlxServerUrl,
    mlxEnabled,
    mlxModel: config.mlxModel || undefined,
    openaiCompatibleUrl: config.openaiCompatibleUrl || undefined,
    openaiCompatibleApiKey: config.openaiCompatibleApiKey || undefined,
    claudeCodeCliPath: config.claudeCodeCliPath || undefined,
    claudeCodeCliModel: config.claudeCodeCliModel || undefined,
  });

  // ---- Graceful model switching (serialized, memory-aware) ----
  let modelSwitchInProgress = false;

  async function handleModelSwitch(newModel: string): Promise<void> {
    const startTime = Date.now();
    bus.emit('model:switch-started', { model: newModel });

    try {
      // 1. Stop current dedicated server first to free VRAM
      if (mlxManager) {
        try { await mlxManager.unloadModel(); } catch { /* best effort */ }
        await mlxManager.stop();
      }
      if (llamaCppManager) {
        await llamaCppManager.stop();
      }
      dedicatedServerVramGB = 0;

      // 2. Unload old model from Ollama to free VRAM
      try {
        const { unloadModel } = await import('../lib/ollama-installer.js');
        await unloadModel(newModel, config.ollamaUrl);
      } catch { /* may not be loaded */ }

      // 3. Re-detect free memory after unload
      const freshDevice = (await import('../lib/device-info.js')).detectDevice();
      const { getMLXModelId: resolveMLX } = await import('../lib/ollama-models.js');
      const newMlxModelId = config.mlxModel || resolveMLX(newModel);
      const newEntry = MODEL_CATALOG.find(m => m.tag === newModel);
      const newModelSizeGB = newEntry?.sizeGB ?? 4;
      const freshVramGB = freshDevice.isAppleSilicon ? freshDevice.totalMemoryGB * 0.75 : (freshDevice.hasNvidiaGpu ? 8 : 0);
      const newFits = newModelSizeGB < freshVramGB * 0.8;

      // 4. Start the appropriate server for the new model
      const kvBits = config.turboQuantBits > 0 ? config.turboQuantBits as 2 | 3 | 4 : undefined;
      let switchedProvider = 'ollama';

      if (freshDevice.mlxAvailable && newMlxModelId && newFits && mlxManager) {
        await mlxManager.start({
          pythonPath: freshDevice.pythonPath || 'python3',
          model: newMlxModelId,
          port: parseInt(new URL(config.mlxServerUrl).port || '8090', 10),
          host: '127.0.0.1',
          kvBits,
          kvQuantScheme: kvBits ? 'turboquant' : undefined,
        });
        dedicatedServerVramGB = newModelSizeGB;
        const caps = mlxManager.getCapabilities();
        if (caps) {
          orchestrator?.setInferenceCapabilities(caps);
          bus.emit('inference:capabilities-changed', caps);
        }
        switchedProvider = 'mlx';
        logger.info({ model: newModel, mlxModel: newMlxModelId }, '[daemon] mlx-vlm restarted with new model');
      } else if (llamaCppManager && config.turboQuantBits > 0 && newFits) {
        const { resolveGgufPath } = await import('../lib/llama-cpp-gguf.js');
        const { LlamaCppManager } = await import('../lib/llama-cpp-manager.js');
        const modelPath = await resolveGgufPath(newModel, config.llamaCppModelPath || undefined);
        const contextSize = computeDynamicNumCtx(newModel, freshDevice, kvBits);

        await llamaCppManager.start({
          binaryPath: config.llamaCppBinaryPath || await LlamaCppManager.ensureBinary(),
          modelPath,
          contextSize,
          cacheTypeK: LlamaCppManager.cacheTypeFromBits(kvBits!),
          cacheTypeV: LlamaCppManager.cacheTypeFromBits(kvBits!),
          gpuLayers: 99,
          flashAttention: true,
          port: parseInt(new URL(config.llamaCppUrl).port || '8085', 10),
          host: '127.0.0.1',
        });
        dedicatedServerVramGB = newModelSizeGB;
        const caps = llamaCppManager.getCapabilities();
        if (caps) {
          orchestrator?.setInferenceCapabilities(caps);
          bus.emit('inference:capabilities-changed', caps);
        }
        switchedProvider = 'llama-cpp';
        logger.info({ model: newModel }, '[daemon] llama-server restarted with new model');
      } else {
        // Fall back to Ollama (no dedicated server, or model too large)
        const { createDefaultCapabilities } = await import('../lib/inference-capabilities.js');
        const defaultCaps = createDefaultCapabilities();
        orchestrator?.setInferenceCapabilities(defaultCaps);
        bus.emit('inference:capabilities-changed', defaultCaps);
        if (!newFits) {
          logger.warn({ model: newModel, modelSizeGB: newModelSizeGB, availableVramGB: freshVramGB },
            '[daemon] Model too large for dedicated server, falling back to Ollama');
        }
      }

      const durationMs = Date.now() - startTime;
      bus.emit('model:switch-complete', { model: newModel, provider: switchedProvider, durationMs });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, model: newModel }, '[daemon] Model switch failed');
      bus.emit('model:switch-failed', { model: newModel, reason });

      // Ensure capabilities reflect reality after failure
      const { createDefaultCapabilities } = await import('../lib/inference-capabilities.js');
      const defaultCaps = createDefaultCapabilities();
      orchestrator?.setInferenceCapabilities(defaultCaps);
      bus.emit('inference:capabilities-changed', defaultCaps);
      dedicatedServerVramGB = 0;
    }
  }

  // Update ModelRouter when user changes active model via the dashboard
  bus.on('ollama:model-changed', (payload: { model: string }) => {
    modelRouter.setOllamaModel(payload.model);
    logger.info(`[daemon] Active Ollama model changed to: ${payload.model}`);

    // Serialize model switches — don't start a new switch while one is in progress
    if (modelSwitchInProgress) {
      logger.warn({ model: payload.model }, '[daemon] Model switch already in progress, skipping');
      return;
    }
    modelSwitchInProgress = true;
    handleModelSwitch(payload.model).finally(() => {
      modelSwitchInProgress = false;
    });
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
  bus.on('cloud:provider-changed', (payload: { provider: string; model?: string }) => {
    const prov = payload.provider as 'anthropic' | 'openrouter';
    modelRouter.setCloudProvider(prov);
    if (payload.model && prov === 'openrouter') {
      modelRouter.setOpenRouterModel(payload.model);
    }
    logger.info(`[daemon] Cloud provider changed to: ${payload.provider}`);
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

  // Register dedicated inference servers so ProcessMonitor includes them in capacity
  if (mlxEnabled && mlxManager) {
    processMonitor.registerExternalProcess('mlx', mlxManager.getUrl(), dedicatedServerVramGB * 1024);
  }
  if (llamaCppManager && llamaCppUrl) {
    processMonitor.registerExternalProcess('llama-cpp', llamaCppUrl, dedicatedServerVramGB * 1024);
  }
  logger.info('[daemon] ProcessMonitor started');

  // 6. Create services
  const scraplingService = new ScraplingService({
    port: config.scraplingPort,
    autoStart: config.scraplingAutoStart,
    proxy: config.scraplingProxy || undefined,
    proxies: config.scraplingProxies.length > 0 ? config.scraplingProxies : undefined,
  });

  const voiceboxService = new VoiceboxService();

  // Auto-start Voicebox if Python is available (non-blocking)
  if (findPythonCommand()) {
    voiceboxService.start()
      .then(() => logger.info('[daemon] Voicebox auto-started'))
      .catch((err) => logger.debug(`[daemon] Voicebox auto-start skipped: ${(err as Error).message}`));
  }

  // Auto-install internet tool dependencies (non-blocking)
  ensureInternetDeps()
    .then(({ ytdlp, gh }) => logger.info(`[daemon] Internet deps: yt-dlp=${ytdlp ? 'ok' : 'unavailable'}, gh=${gh ? 'ok' : 'unavailable'}`))
    .catch((err) => logger.debug(`[daemon] Internet deps check skipped: ${(err as Error).message}`));

  // 7. Connect to cloud (connected tier only)
  let controlPlane: ControlPlaneClient | null = null;
  const engineRef: { current: RuntimeEngine | null } = { current: null };
  const triggerEvaluatorRef: { current: LocalTriggerEvaluator | null } = { current: null };

  // Clear any stale replaced marker unconditionally at daemon startup.
  // If the daemon process starts at all, the marker's job (prevent respawn) is done.
  // This must happen before cloud connect — if connect fails, the marker would persist.
  clearReplacedMarker(dataDir);

  // Multi-workspace safety: if this workspace is cloud-mode and has a pinned
  // cloudWorkspaceId from a prior connect, refuse to boot if any OTHER local
  // workspace also points at that cloud id. Two local workspaces cannot mirror
  // the same cloud workspace — that's exactly the silent-data-collision bug
  // workspace isolation exists to prevent.
  const activeWsName = resolveActiveWorkspace().name;
  const activeWs = readWorkspaceConfig(activeWsName);
  if (activeWs?.mode === 'cloud' && activeWs.cloudWorkspaceId) {
    const conflict = findWorkspaceByCloudId(activeWs.cloudWorkspaceId);
    if (conflict && conflict !== activeWsName) {
      throw new Error(
        `Cloud workspace ${activeWs.cloudWorkspaceId} is already bound to local workspace ` +
          `"${conflict}". Two local workspaces cannot mirror the same cloud workspace. ` +
          `Run "ohwow workspace unlink ${conflict}" first or use a different license.`,
      );
    }
  }

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

  // Multi-workspace: persist the cloud identity the control plane resolved for
  // this workspace. Future boots use it for mirror detection (above) and for
  // `ohwow workspace info` display. If we had a pinned cloudWorkspaceId and
  // the cloud returned a different one, that signals a license reassignment —
  // refuse rather than silently re-pointing at a different cloud brain.
  if (controlPlane?.connectedWorkspaceId && activeWs?.mode === 'cloud') {
    const resolvedCloudId = controlPlane.connectedWorkspaceId;
    if (activeWs.cloudWorkspaceId && activeWs.cloudWorkspaceId !== resolvedCloudId) {
      throw new Error(
        `Workspace "${activeWsName}" is pinned to cloud workspace ${activeWs.cloudWorkspaceId} ` +
          `but the cloud returned ${resolvedCloudId}. License key may have been reassigned. ` +
          `Re-link the workspace explicitly if this is intentional.`,
      );
    }
    writeWorkspaceConfig(activeWsName, {
      ...activeWs,
      cloudWorkspaceId: resolvedCloudId,
      cloudDeviceId: controlPlane.connectedDeviceId ?? undefined,
      lastConnectAt: new Date().toISOString(),
    });
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
    browserTarget: config.browserTarget,
    chromeCdpPort: config.chromeCdpPort,
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
    desktopToolsEnabled: config.desktopToolsEnabled,
  }, {
    reportToCloud: controlPlane ? (report) => controlPlane!.reportTask(report) : () => Promise.resolve(),
  }, businessContext, bus, modelRouter, scraplingService);
  engineRef.current = engine;

  // Diary hook: append a JSONL entry to <dataDir>/diary.jsonl on every
  // task completion. Cheap persistent memory for later reflection, and a
  // readable "what did my agents do today" log for the operator. Subscribe
  // on the bus the engine emits through.
  installDiaryHook(bus, rawDb, { dataDir });

  // 9. Start polling (connected tier only)
  if (controlPlane) {
    controlPlane.startPolling();
    controlPlane.startHeartbeats();
  }

  // 10. Initialize channel registry + orchestrator
  //
  // Canonical workspace identity: when the control plane is connected the
  // daemon adopts the cloud Supabase workspace UUID; otherwise it falls back
  // to the "local" sentinel. ALL internal state (orchestrator context, HTTP
  // API auth middleware, triggers, messaging, etc.) must use this single id
  // so that data created via any path lands in the same workspace scope and
  // is visible to every other path.
  //
  // Earlier code split this into local vs cloud identities and that caused
  // a silent fragmentation: contacts inserted via /api/contacts with the
  // "local" scope were invisible to the orchestrator which was querying
  // with the cloud scope (and vice versa). The fix is unification, not
  // splitting.
  const workspaceId = controlPlane?.connectedWorkspaceId || 'local';

  // Workspace consolidation: unify every local SQLite row to the canonical
  // workspace id. If the control plane is connected, that's the cloud
  // Supabase workspace UUID; otherwise it's the "local" sentinel.
  //
  // This fixes a real fragmentation that can happen over the daemon's
  // lifetime: rows can end up scoped to the "local" sentinel (from
  // disconnected-mode inserts or old hardcoded code paths), to the
  // currently-connected cloud workspace id, OR to a previous cloud
  // workspace id if the user ever connected to a different workspace.
  // Without consolidation, each workspace "shard" is silently invisible
  // to code scoped at the canonical id, and the orchestrator sees a
  // subset of the real local state.
  //
  // Idempotent: if all rows already share the canonical id, this is a
  // no-op. Runs once at startup, after the cloud connect handshake.
  {
    const consolidationTables = [
      'agent_workforce_contacts',
      'agent_workforce_contact_events',
      'agent_workforce_agents',
      'agent_workforce_tasks',
      'agent_workforce_task_state',
      'agent_workforce_task_messages',
      'agent_workforce_activity',
      'agent_workforce_knowledge_documents',
      'agent_workforce_knowledge_chunks',
      'agent_workforce_knowledge_agent_config',
      'agent_workforce_deliverables',
      'agent_workforce_projects',
      'agent_workforce_goals',
      'agent_workforce_revenue_entries',
      'agent_workforce_schedules',
      'agent_workforce_sessions',
      'agent_workforce_agent_memory',
      'agent_workforce_memory_extraction_log',
      'agent_workforce_state_changelog',
      'agent_workforce_action_journal',
      'agent_workforce_sequence_runs',
      'agent_workforce_anomaly_alerts',
      'agent_workforce_skills',
      'agent_workforce_digital_twin_snapshots',
      'agent_workforce_nudges',
      'agent_workforce_briefings',
      'agent_workforce_person_models',
      'agent_workforce_person_observations',
      'agent_workforce_operational_pillars',
      'agent_workforce_pillar_instances',
      'agent_workforce_workflows',
      'agent_workforce_workflow_runs',
      'agent_workforce_workflow_triggers',
      'agent_workforce_departments',
      'agent_workforce_team_members',
      'agent_workforce_plans',
      'agent_workforce_plan_steps',
      'agent_workforce_principles',
      'agent_workforce_proactive_runs',
      'agent_workforce_evolution_attempts',
      'agent_workforce_evolution_runs',
      'agent_workforce_lifecycle_events',
      'agent_workforce_tool_recordings',
      'agent_workforce_practice_sessions',
      'agent_workforce_data_store',
      'agent_workforce_routing_stats',
      'agent_workforce_attachments',
      'agent_workforce_shadow_runs',
    ];
    let totalMigrated = 0;
    const perTable: Record<string, number> = {};
    for (const table of consolidationTables) {
      try {
        // Normalize every row whose workspace_id is NOT already the canonical
        // id. This handles "local" rows, stale cloud-UUID rows from prior
        // connections, AND any other drift. We do not rewrite rows that are
        // already correct so the operation stays cheap on warm restarts.
        const result = rawDb
          .prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id != ?`)
          .run(workspaceId, workspaceId);
        if (result.changes > 0) {
          perTable[table] = result.changes;
          totalMigrated += result.changes;
        }
      } catch {
        // Table may not have a workspace_id column, may not exist on this
        // schema version, or may have unique constraints that conflict. We
        // iterate a broad list on purpose and skip failures silently so the
        // daemon still starts.
      }
    }
    if (totalMigrated > 0) {
      logger.info(
        { perTable, totalMigrated, canonical: workspaceId },
        `[daemon] Workspace consolidation: unified ${totalMigrated} row(s) across ${Object.keys(perTable).length} table(s) to canonical workspace id`,
      );
    }

    // Rename the parent workspaces row too. The child-table pass above
    // rewrites workspace_id on every dependent row to the canonical id,
    // but the agent_workforce_workspaces primary key itself is untouched.
    // When child tables have FK constraints like
    //   workspace_id REFERENCES agent_workforce_workspaces(id)
    // inserts fail because the canonical id has no parent row. This is
    // exactly what blocked start_person_ingestion — team_members rows
    // were already on canonical, but the workspaces row still said
    // "local", so a fresh person_models insert hit FOREIGN KEY
    // constraint failed. Fix by renaming the parent in place.
    try {
      const parentCount = (rawDb
        .prepare('SELECT COUNT(*) AS c FROM agent_workforce_workspaces WHERE id = ?')
        .get(workspaceId) as { c: number } | undefined)?.c ?? 0;
      if (parentCount === 0) {
        const renameResult = rawDb
          .prepare('UPDATE agent_workforce_workspaces SET id = ? WHERE id != ?')
          .run(workspaceId, workspaceId);
        if (renameResult.changes > 0) {
          logger.info(
            { canonical: workspaceId, renamed: renameResult.changes },
            '[daemon] Workspace consolidation: renamed parent workspaces row to canonical id',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, '[daemon] Workspace parent-row rename skipped');
    }
  }

  const channelRegistry = new ChannelRegistry();
  const connectorRegistry = new ConnectorRegistry();
  connectorRegistry.registerFactory('github', (cfg) => new GitHubConnector(cfg));
  connectorRegistry.registerFactory('google-drive', (cfg) => new GoogleDriveConnector(cfg));
  connectorRegistry.registerFactory('local-files', (cfg) => new LocalFilesConnector(cfg));
  connectorRegistry.registerFactory('notion', (cfg) => new NotionConnector(cfg));
  const triggerEvaluator = new LocalTriggerEvaluator(db, engine, workspaceId, channelRegistry);
  triggerEvaluatorRef.current = triggerEvaluator;

  // Workers skip orchestrator/messaging (task execution only)
  const orchestrator = isWorker ? null : new LocalOrchestrator(
    db, engine, workspaceId, config.anthropicApiKey,
    channelRegistry, controlPlane!, modelRouter, scraplingService, config.orchestratorModel, process.cwd(),
    config.browserHeadless, dataDir, config.mcpServers,
    config.browserTarget, config.chromeCdpPort,
    config.desktopToolsEnabled,
  );

  if (orchestrator) {
    orchestrator.setRagConfig({
      ollamaUrl: config.ollamaUrl,
      embeddingModel: config.embeddingModel,
      ollamaModel: config.ollamaModel,
      ragBm25Weight: config.ragBm25Weight,
      rerankerEnabled: config.rerankerEnabled,
      meshRagEnabled: config.meshRagEnabled,
    });
    orchestrator.setConnectorRegistry(connectorRegistry);
    orchestrator.setChromeProfileAliases(config.chromeProfileAliases);
    orchestrator.setSkipMediaCostConfirmation(config.skipMediaCostConfirmation);

    // LSP manager — lazy-start language servers on first tool call
    if (config.lspEnabled) {
      const { LspManager } = await import('../lsp/lsp-manager.js');
      const lspManager = new LspManager(process.cwd());
      orchestrator.setLspManager(lspManager);
      bus.on('shutdown', () => { lspManager.stopAll().catch(() => {}); });
    }
    if (inferenceCapabilities) {
      orchestrator.setInferenceCapabilities(inferenceCapabilities);
      bus.emit('inference:capabilities-changed', inferenceCapabilities);
    }

    // Initialize meeting session (macOS only)
    if (process.platform === 'darwin') {
      const { MeetingSession } = await import('../meeting/meeting-session.js');
      const openaiKey = (engine as unknown as { config?: { openaiApiKey?: string } })?.config?.openaiApiKey;
      const meetingSession = new MeetingSession(
        db, modelRouter, controlPlane, workspaceId,
        config.ollamaUrl, openaiKey,
      );
      orchestrator.setMeetingSession(meetingSession);
      if (controlPlane) {
        controlPlane.setMeetingSession(meetingSession);
      }
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

  // Wire consciousness bridge for persistence and cloud sync
  if (orchestrator) {
    const orchBrain = orchestrator.getBrain();
    if (orchBrain) {
      const consciousnessBridge = new ConsciousnessBridge(db, orchBrain.workspace, workspaceId);
      orchBrain.setConsciousnessBridge(consciousnessBridge);
      consciousnessBridge.hydrate().catch(err => {
        logger.debug({ err }, '[daemon] Consciousness hydration failed');
      });
      // Wire to control plane for cloud sync (if connected)
      if (controlPlane) {
        controlPlane.setConsciousnessBridge(consciousnessBridge);
      }
    }
  }

  logger.info(`[body] Digital body created with ${digitalBody.getOrgans().length} organs, nervous system started`);

  let messageRouter: MessageRouter | null = null;
  if (!isWorker) {
    messageRouter = new MessageRouter({ orchestrator: orchestrator!, channelRegistry, rawDb, db, workspaceId, triggerEvaluator, eventBus: bus });
  }

  // Device data fetcher (for device-pinned data)
  let deviceFetcher: import('../data-locality/fetch-client.js').DeviceDataFetcher | null = null;
  if (controlPlane?.connectedDeviceId) {
    const { DeviceDataFetcher } = await import('../data-locality/fetch-client.js');
    const { createPeerResolver } = await import('../data-locality/resolve-peer.js');

    deviceFetcher = new DeviceDataFetcher({
      db,
      workspaceId,
      deviceId: controlPlane.connectedDeviceId,
      cloudUrl: config.cloudUrl || '',
      sessionToken: controlPlane.cloudSessionToken,
      resolvePeer: createPeerResolver(db, {
        cloudUrl: config.cloudUrl,
        sessionToken: controlPlane.cloudSessionToken,
      }),
    });

    // Wire into engine for device-pinned memory retrieval during tasks
    engine.setDeviceFetcher(deviceFetcher);
  }

  // 11. Start Express server + WebSocket
  let waClient: WhatsAppClient | null = null;
  let scheduler: LocalScheduler | null = null;
  let connectorSyncScheduler: ConnectorSyncScheduler | null = null;
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
    ragConfig: {
      ollamaUrl: config.ollamaUrl,
      embeddingModel: config.embeddingModel,
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

      // Wire BPP modules into scheduler (deferred: philosophical layers load async)
      setTimeout(async () => {
        const bpp = orchestrator!.getBppModules();
        if (bpp.homeostasis && scheduler) {
          scheduler.setHomeostasis(bpp.homeostasis);
          logger.debug('[daemon] Wired homeostasis -> scheduler');
        }

        // Wire burn-throttle: revenue_vs_burn pressure clamps model
        // routing to local-only when business cost exceeds margin.
        // See src/homeostasis/homeostasis-controller.ts getBurnThrottleLevel.
        if (bpp.homeostasis) {
          const controller = bpp.homeostasis;
          modelRouter.setBurnThrottleProvider(() => controller.getBurnThrottleLevel());
          logger.debug('[daemon] Wired burn-throttle -> model router');
        }

        // Wire bios boundary check: defer schedules during off-hours
        try {
          const { inferBoundary, isBoundaryActive } = await import('../bios/boundary-guardian.js');
          // Gather recent activity timestamps for boundary inference.
          // Real table is agent_workforce_activity — the legacy agent_activity
          // name was never migrated here, so the query silently returned empty
          // and every workspace fell back to the hardcoded 9-17 default.
          const { data: activity } = await db.from('agent_workforce_activity')
            .select('created_at')
            .eq('workspace_id', workspaceId)
            .order('created_at', { ascending: false })
            .limit(200);
          const timestamps = (activity ?? []).map((r: Record<string, unknown>) => new Date(r.created_at as string).getTime());
          const boundary = inferBoundary(timestamps);
          if (scheduler) {
            scheduler.setBiosDeferCheck(() => isBoundaryActive(boundary));
            logger.debug('[daemon] Wired bios boundary -> scheduler');
          }
        } catch { /* bios wiring is non-fatal */ }

        // Wire BPP modules into control plane for cloud sync
        if (controlPlane) {
          controlPlane.setBppModules(bpp);
          logger.debug('[daemon] Wired BPP modules -> control plane');
        }
      }, 2000);
    }

    // Proactive engine
    proactiveEngine = new ProactiveEngine(db, workspaceId, bus);
    proactiveEngine.start().catch(err => {
      logger.warn(`[daemon] Proactive engine failed: ${err instanceof Error ? err.message : err}`);
    });

    // Transition engine: listens for task completions and evaluates stage progression
    {
      const transitionEngine = new LocalTransitionEngine(db, workspaceId);
      bus.on('task:completed', async (data) => {
        if (data.status !== 'completed') return;
        try {
          const { data: task } = await db
            .from('agent_workforce_tasks')
            .select('title, duration_seconds, output')
            .eq('id', data.taskId)
            .single();
          if (!task) return;
          const durationSeconds = (task.duration_seconds as number) || 0;
          // Extract tool names from output JSON if available
          let toolsUsed: string[] = [];
          if (task.output) {
            try {
              const output = typeof task.output === 'string' ? JSON.parse(task.output as string) : task.output;
              if (Array.isArray(output?.toolsUsed)) toolsUsed = output.toolsUsed;
              else if (Array.isArray(output?.tools)) toolsUsed = output.tools;
            } catch { /* empty */ }
          }
          await transitionEngine.onTaskCompleted({
            taskId: data.taskId,
            taskTitle: (task.title as string) || '',
            agentId: data.agentId,
            toolsUsed,
            status: data.status,
            truthScore: null,
            durationSeconds,
          });
        } catch (err) {
          logger.debug({ err, taskId: data.taskId }, '[daemon] Transition engine hook error');
        }
      });
      logger.debug('[daemon] Transition engine listener registered');
    }

    // Work Router: records routing outcomes when routed tasks complete
    {
      const workRouter = new LocalWorkRouter(db, workspaceId);
      bus.on('task:completed', async (data) => {
        try {
          // Check if this task has a routing decision
          const { data: decision } = await db
            .from('work_routing_decisions')
            .select('id, outcome')
            .eq('task_id', data.taskId)
            .single();

          if (decision && !decision.outcome) {
            const { data: task } = await db
              .from('agent_workforce_tasks')
              .select('duration_seconds')
              .eq('id', data.taskId)
              .single();

            const actualMinutes = task?.duration_seconds
              ? Math.round((task.duration_seconds as number) / 60)
              : undefined;

            await workRouter.recordOutcome(
              decision.id as string,
              data.status === 'completed' ? 'completed' : 'rejected',
              undefined,
              actualMinutes,
            );
          }
        } catch (err) {
          logger.debug({ err, taskId: data.taskId }, '[daemon] Work Router outcome hook error');
        }
      });
      logger.debug('[daemon] Work Router outcome listener registered');
    }

    // Person Model refinement: processes unprocessed observations every hour
    {
      const REFINEMENT_INTERVAL = 60 * 60_000; // 1 hour
      setInterval(() => {
        runPersonModelRefinement(db, workspaceId).catch(err => {
          logger.debug({ err }, '[daemon] Person model refinement error');
        });
      }, REFINEMENT_INTERVAL);
      logger.debug('[daemon] Person model refinement scheduled (1h interval)');
    }

    // Self-bench experiment runner: the substrate for continuous
    // self-testing. Every registered Experiment fires on its cadence,
    // lands a row in self_findings, and (if it implements intervene)
    // changes config when its judge says so. Phase 1 registers two
    // wrappers around existing reliability checks:
    //   - ModelHealthExperiment: subsumes the old 10-minute
    //     refreshDemotedAgentModels interval — the probe still calls
    //     that refresher, but now the refresh outcome lands as a
    //     finding instead of disappearing into a log line.
    //   - TriggerStabilityExperiment: polls the trigger watchdog
    //     counters every 5 minutes so "is any cron silently broken"
    //     is answerable from the ledger without an operator query.
    // Phase 2-5 will add canary probes, re-promotion, intervention
    // validation, and the meta-loop that picks what to probe next.
    {
      // Phase 5-B: runtime config overrides cache. Experiments read
      // runtime-mutable settings via getRuntimeConfig() which
      // synchronously reads this cache. Prime on boot + refresh every
      // 60 seconds so writes from other processes (or other
      // experiment runs) become visible within a minute.
      void refreshRuntimeConfigCache(db);
      setInterval(() => {
        void refreshRuntimeConfigCache(db);
      }, RUNTIME_CONFIG_REFRESH_INTERVAL_MS);

      // Phase 7-A: configure the self-commit repo root from the
      // daemon binary path. Derives /path/to/repo from
      // /path/to/repo/dist/index.js. Self-commit stays disabled
      // by default regardless — the kill-switch file at
      // ~/.ohwow/self-commit-enabled is the operator's opt-in.
      try {
        const entryPath = process.argv[1];
        if (entryPath) {
          const derived = dirname(dirname(entryPath));
          setSelfCommitRepoRoot(derived);
          logger.debug({ repoRoot: derived }, '[daemon] self-commit repo root configured');
        }
      } catch (err) {
        logger.debug({ err }, '[daemon] could not configure self-commit repo root');
      }

      if (engine) {
        // workspaceId is the consolidated row id (cloud UUID or 'local');
        // workspaceSlug is the human-readable name ('default', 'avenued', ...)
        // that business experiments match against.
        const workspaceSlug = resolveActiveWorkspace().name;
        const experimentRunner = new ExperimentRunner(db, engine, workspaceId, workspaceSlug);
        experimentRunner.register(new ModelHealthExperiment());
        experimentRunner.register(new TriggerStabilityExperiment());
        // Phase 2: CanaryExperiment runs the direct-dispatch tool
        // suite every 15m so substrate regressions surface even when
        // no real task traffic is exercising the executors.
        experimentRunner.register(new CanaryExperiment());
        // Phase 2: LedgerHealthExperiment watches the runner itself
        // — reads its own ledger to detect stalled or erroring peers.
        experimentRunner.register(new LedgerHealthExperiment());
        // Phase 2: StaleTaskCleanupExperiment is the first actionable
        // experiment — it sweeps zombie in_progress tasks every 5m,
        // marks them failed, and resets their agents to idle. The
        // cleanup is reversible by reading the ledger's
        // intervention_applied field.
        experimentRunner.register(new StaleTaskCleanupExperiment());
        // Phase 4: AdaptiveSchedulerExperiment is the meta-loop that
        // reads the ledger every 10m and adjusts peer cadences: pass
        // streaks get stretched (up to 4x), recent failures get
        // pulled in to 60s re-probe. This is the mechanic that makes
        // probe budget follow signal instead of running every
        // experiment on a static schedule forever.
        experimentRunner.register(new AdaptiveSchedulerExperiment());
        // Phase 5-C: StaleTaskThresholdTunerExperiment is the first
        // experiment that uses the full reversible-config loop:
        // reads recent stale-task-cleanup patterns, proposes a
        // threshold widening via runtime_config_overrides, validates
        // the change after 20 minutes, and rolls back automatically
        // if the adjustment didn't help.
        experimentRunner.register(new StaleTaskThresholdTunerExperiment());
        // Phase 6: AgentCoverageGapExperiment enumerates the live
        // agent_workforce_agents table every hour and writes a
        // per-agent gap-filler finding for any agent showing stale
        // or high-fail-rate shape. First experiment whose probe
        // subjects are discovered at runtime rather than hardcoded.
        experimentRunner.register(new AgentCoverageGapExperiment());
        // Phase 7-C: ExperimentProposalGenerator reads llm_calls
        // + the existing ledger every hour and writes
        // ExperimentBrief rows as findings with
        // category='experiment_proposal'. The briefs sit in the
        // ledger until Phase 7-D picks them up and authors the
        // corresponding code autonomously.
        experimentRunner.register(new ExperimentProposalGenerator());
        // Phase 7-D: ExperimentAuthorExperiment is the terminal
        // slice of autonomous code authoring. Reads unclaimed
        // proposals, runs fillExperimentTemplate, calls
        // safeSelfCommit which path-restricts + gates + commits.
        // Gated behind ~/.ohwow/self-commit-enabled — production
        // stays closed until the operator opts in.
        experimentRunner.register(new ExperimentAuthorExperiment());
        // E4/E5/E6 flaw-hunt audits wrapped as scheduled experiments.
        // All three are read-only: the fuzz watches for hidden
        // list-handler truncation, the schema-drift audit AST-walks
        // every tool handler against its declared schema, and the
        // prose-invariant audit re-verifies hand-curated CLAUDE.md +
        // constant-value claims against the live tree.
        experimentRunner.register(new ListHandlersFuzzExperiment());
        experimentRunner.register(new HandlerSchemaDriftExperiment());
        experimentRunner.register(new ProseInvariantDriftExperiment());
        // Closes the blind spot surfaced by the 2026-04-14 ohwow-self
        // introspection run: infrastructure-level experiments all pass
        // while an agent can be silently drowning in failed tasks.
        // Per-agent failure-rate watchdog on a 24h rolling window.
        experimentRunner.register(new AgentOutcomesExperiment());
        // Step 2 of the autonomous-fixing safety floor: meta-watcher over
        // the autonomous code-authoring pipeline. Surfaces commit volume,
        // templated-family slop, ghost probes, and verdict-mix collapse
        // as evidence so the operator can decide whether to widen the
        // patch allowlist or throttle the author back. Pure observer.
        experimentRunner.register(new AutonomousAuthorQualityExperiment());
        // Layer 5b of the safety floor: cool-off watcher that reads
        // Fixes-Finding-Id trailers on autonomous commits in the last
        // 30min and fires git revert + push when the justifying
        // finding re-fires with verdict=warning|fail on the same
        // experiment_id + subject after the commit. Intervene is gated
        // by ~/.ohwow/auto-revert-enabled — without that file the
        // experiment flags candidates in the ledger but does not
        // mutate main. Probe is read-only and always safe to run.
        experimentRunner.register(new AutonomousPatchRollbackExperiment());
        // Convergence health monitor: measures hold_rate (patches that
        // held vs reverted in 24h) and violation pool trend. Observe-
        // only — signals whether the patch loop is converging or
        // thrashing. Verdict=fail triggers operator attention.
        experimentRunner.register(new PatchLoopHealthExperiment());
        // Capstone application of Layers 1-9: discovers self_findings
        // whose affected_files intersect a tier-2 path and surfaces
        // them as patch candidates. Observe-only on first ship — does
        // NOT call a model and does NOT call safeSelfCommit. Once a
        // few cycles confirm the discovery half is sound, a follow-up
        // wires the model + Layer 8 prompt + Layer 4 AST bound +
        // Layer 2 trailer + safeSelfCommit. See the experiment header
        // for the gating criteria.
        experimentRunner.register(new PatchAuthorExperiment());
        // Keeps AUTONOMY_ROADMAP.md in sync with live loop state.
        // Fires when the doc is >2h old AND at least one noteworthy
        // signal is present (loop fail, violation pool surge, or
        // experiment files missing from the roadmap). Tier-2 modify.
        experimentRunner.register(new RoadmapUpdaterExperiment());
        // Structural invariants for the three-file roadmap suite. Fires
        // fail findings the moment a RoadmapUpdaterExperiment patch
        // drops an anchor H2, reorders the iteration log, or dangles a
        // cross-link. Wired into safeSelfCommit in a follow-up so
        // those patches auto-revert.
        experimentRunner.register(new RoadmapShapeProbeExperiment());
        // Vitest as an in-loop signal. Runs the self-bench test glob
        // every 30min and emits fail findings for any failing test
        // file. Observe-only; the PatchAuthor pipeline reacts when the
        // affected_files point at patchable paths.
        experimentRunner.register(new VitestHealthProbeExperiment());
        // Self-observation: every minute, compute per-peer median
        // inter-run gap and flag stale experiments. Operators no
        // longer need to eyeball sqlite to know the loop is healthy.
        experimentRunner.register(new LoopCadenceProbeExperiment());
        // Surfaces tier-2 sources that lack a sibling vitest suite.
        // Emits warning findings whose affected_files is the proposed
        // new test path under a tier-1 prefix, ready for new-file
        // authoring.
        experimentRunner.register(new TestCoverageProbeExperiment());
        // Phase B — first surprise-source experiment. Property-tests
        // src/lib/format-duration.ts (a tier-2 path) on a deterministic
        // seeded corpus. On a correct implementation this stays at zero
        // violations forever (heartbeat over the contract). If the
        // formatter ever drifts, it emits a fail finding with
        // affected_files = ['src/lib/format-duration.ts'] — exactly
        // what PatchAuthorExperiment is watching for.
        experimentRunner.register(new FormatDurationFuzzExperiment());
        // Three additional tier-2 surprise sources — same property-fuzz
        // pattern pointed at different pure utilities. Each 5-min tick
        // runs ~100-200 samples against its target and emits a fail
        // finding on drift.
        experimentRunner.register(new TokenSimilarityFuzzExperiment());
        experimentRunner.register(new StagnationFuzzExperiment());
        experimentRunner.register(new ErrorClassificationFuzzExperiment());
        // Self-UX loop, Sprint 1 — guards DASHBOARD_SITEMAP against
        // App.tsx drift. Observe-only; fires a warning finding when
        // the sitemap and the SPA routes disagree.
        experimentRunner.register(new SitemapDriftExperiment());
        // Walks every smokeable route in a headless Chromium,
        // collecting console errors + HTTP 4xx/5xx + ErrorBoundary
        // titles. Every 10min. Observe-only until tier-2-ui lands.
        experimentRunner.register(new DashboardSmokeExperiment());
        // Lints the rendered text of each dashboard route against
        // COPY_RULES. 15min cadence. Observe-only — closes the loop
        // once tier-2-copy lands.
        experimentRunner.register(new DashboardCopyExperiment());
        // Source-side copy lint: scans src/web/src string literals,
        // template literals, and JSX text for the same rules. The
        // intersection of source + DOM findings is the high-signal
        // set the (future) copy patch-author should act on.
        experimentRunner.register(new SourceCopyLintExperiment());
        // Phase 8-A (live): ContentCadenceTunerExperiment is the first
        // BusinessExperiment in the live runner. Gated behind workspaceSlug
        // === 'default' because its probe anchors to a business goal that
        // only makes sense on the GTM dogfood workspace.
        //
        // ContentCadenceScheduler (also registered below) is the downstream
        // consumer that reads content_cadence.posts_per_day, dispatches X
        // post tasks when under the daily budget, and keeps
        // goal.current_value current so validate() sees real signal.
        //
        // Env var: OHWOW_CONTENT_CADENCE_TUNER_FAST=1 accelerates the loop
        // to 5-minute probe cadence + 5-minute validation delay for local
        // smoke testing. In production the class defaults are 6h / 24h.
        if (workspaceSlug === 'default') {
          const cadenceTuner = new ContentCadenceTunerExperiment({ dryRun: false });
          const fast = process.env.OHWOW_CONTENT_CADENCE_TUNER_FAST;
          if (fast === '1' || fast === 'true') {
            cadenceTuner.cadence = {
              everyMs: 5 * 60 * 1000,
              runOnBoot: true,
              validationDelayMs: 5 * 60 * 1000,
            };
          }
          experimentRunner.register(cadenceTuner);
          logger.info(
            {
              experimentId: cadenceTuner.id,
              dryRun: cadenceTuner.dryRun,
              fastCadence: fast === '1' || fast === 'true',
              everyMs: cadenceTuner.cadence.everyMs,
              validationDelayMs: cadenceTuner.cadence.validationDelayMs,
            },
            '[daemon] content-cadence-tuner registered in live mode',
          );

          // Phase 8-A: ContentCadenceScheduler — downstream consumer that
          // reads content_cadence.posts_per_day every hour, seeds the
          // x_posts_per_week goal row on first run, dispatches X post tasks
          // when under the daily budget, and updates goal.current_value with
          // the trailing-7d count so validate() has real signal.
          const cadenceScheduler = new ContentCadenceScheduler(db, engine, workspaceId);
          cadenceScheduler.start();
          logger.info('[daemon] content-cadence-scheduler started');

          // Phase 8-A.3: ContentCadenceLoopHealthExperiment — meta-watcher
          // that detects silent failures across the closed loop's stages.
          // Three real bugs already shipped without any infra experiment
          // catching them (scheduler agent filter, scheduler column name,
          // goal seed semantics); this watcher fires on the vital signs
          // (scheduler tick freshness, dispatch count, completion ratio,
          // tuner cadence, validation-chain integrity) so the next class
          // of silent failure surfaces in the ledger inside an hour
          // instead of after a day of grep-by-hand log inspection.
          //
          // Env var: OHWOW_CONTENT_CADENCE_LOOP_HEALTH_FAST=1 accelerates
          // the watcher to 5-minute cadence for live observation runs (e.g.
          // verifying the verdict shifts as the loop heals after a fix).
          // Unset, the watcher inherits its class default (1h) so production
          // gets ~24 ticks/day — enough granularity for a meta-watcher
          // without flooding the ledger.
          const loopHealth = new ContentCadenceLoopHealthExperiment();
          const loopHealthFast = process.env.OHWOW_CONTENT_CADENCE_LOOP_HEALTH_FAST;
          if (loopHealthFast === '1' || loopHealthFast === 'true') {
            loopHealth.cadence = {
              everyMs: 5 * 60 * 1000,
              runOnBoot: true,
            };
          }
          experimentRunner.register(loopHealth);
          logger.info(
            {
              fastCadence: loopHealthFast === '1' || loopHealthFast === 'true',
              everyMs: loopHealth.cadence.everyMs,
            },
            '[daemon] content-cadence-loop-health registered',
          );
        }

        // Phase 8-A.1: LLM provider availability — watches failure rates
        // per provider in a rolling 1h window. Warns at >5%, fails at >20%.
        // No intervene; routing adaptation is Phase 8-B.
        experimentRunner.register(new ProviderAvailabilityExperiment());

        // Phase 8-A.2: Agent lock contention — detects agents marked
        // 'working' whose active task hasn't updated in >30 minutes.
        // Warns at 10% stalled agents, fails at 30%.
        experimentRunner.register(new AgentLockContentionExperiment());

        // Phase 8-A.3: List handler completeness digest — meta-experiment
        // that surfaces a weekly summary of list-handlers-fuzz findings
        // as a business-facing signal. 1h cadence.
        experimentRunner.register(new ListCompletenessSummaryExperiment());

        // Phase 8-B: AgentTaskCostWatcherExperiment — observer for the
        // rolling 7d avg cost per completed task. Anchors to the
        // agent_avg_task_cost_cents goal (operator creates via UI with a
        // target value in cents). Warns when avg exceeds target; no
        // intervention until Phase 8-B.2 adds a routing knob.
        experimentRunner.register(new AgentTaskCostWatcherExperiment());

        // Auto-registry: every experiment autonomously authored by
        // ExperimentAuthorExperiment is listed in auto-registry.ts.
        // Dynamic import here so daemon restart is the only coupling —
        // the author commits the registry update, the daemon picks it
        // up on the next boot without any code change to this file.
        try {
          const { autoRegisteredExperiments } = await import('../self-bench/auto-registry.js');
          for (const factory of autoRegisteredExperiments) {
            experimentRunner.register(factory());
          }
          logger.info(
            { count: autoRegisteredExperiments.length },
            '[daemon] auto-registry experiments registered',
          );
        } catch (err) {
          // Non-fatal: auto-registry may not exist yet (fresh install).
          logger.debug({ err }, '[daemon] auto-registry not found or failed to load');
        }

        await experimentRunner.rehydrateSchedule().catch((err) => {
          logger.warn({ err }, '[daemon] rehydrateSchedule failed; continuing with fresh schedule');
        });
        experimentRunner.start();
        logger.debug(
          { experiments: experimentRunner.registeredIds() },
          '[daemon] self-bench experiment runner started',
        );
      } else {
        logger.debug('[daemon] engine unavailable — experiment runner skipped');
      }
    }

    // Human Growth Engine: compute growth snapshots alongside refinement
    {
      const GROWTH_INTERVAL = 60 * 60_000; // 1 hour (same as refinement)
      setInterval(async () => {
        try {
          const growthEngine = new HumanGrowthEngine(db, workspaceId);
          const { data: people } = await db
            .from('agent_workforce_person_models')
            .select('id')
            .eq('workspace_id', workspaceId)
            .in('ingestion_status', ['initial_complete', 'mature']);

          for (const person of (people || [])) {
            await growthEngine.computeAndStoreSnapshot(person.id as string).catch(err => {
              logger.debug({ err, personId: person.id }, '[daemon] Growth snapshot error');
            });
          }
        } catch (err) {
          logger.debug({ err }, '[daemon] Human growth engine error');
        }
      }, GROWTH_INTERVAL);
      logger.debug('[daemon] Human growth engine scheduled (1h interval)');
    }

    // Observation Engine: compute work pattern maps alongside growth
    {
      const OBS_INTERVAL = 60 * 60_000; // 1 hour
      setInterval(async () => {
        try {
          const obsEngine = new ObservationEngine(db, workspaceId);
          const { data: people } = await db
            .from('agent_workforce_person_models')
            .select('id')
            .eq('workspace_id', workspaceId)
            .in('ingestion_status', ['initial_complete', 'mature']);

          for (const person of (people || [])) {
            await obsEngine.computeWorkPatternMap(person.id as string).catch(err => {
              logger.debug({ err, personId: person.id }, '[daemon] Observation engine error');
            });
          }
        } catch (err) {
          logger.debug({ err }, '[daemon] Observation engine error');
        }
      }, OBS_INTERVAL);
      logger.debug('[daemon] Observation engine scheduled (1h interval)');
    }

    // Heartbeat coordinator: wakes agents on a configurable cadence
    const heartbeatCoordinator = new HeartbeatCoordinator(db, engine, workspaceId);
    heartbeatCoordinator.start().catch(err => {
      logger.warn(`[daemon] Heartbeat coordinator failed: ${err instanceof Error ? err.message : err}`);
    });

    // Self-improvement scheduler: runs daily, gates LLM phases on task volume.
    // Phase C: hand the shared synthesis bus in BEFORE start() so mined tool
    // patterns emit `synthesis:candidate` events with `kind: 'pattern'`,
    // which the SynthesisAutoLearner (wired further down) picks up and
    // persists as code-skill rows. Before this wire, the pattern miner
    // produced data but the bridge in skill-synthesizer.ts had no bus to
    // emit on — it ran as a no-op and patterns were dropped.
    const improvementScheduler = new ImprovementScheduler(db, modelRouter, workspaceId);
    improvementScheduler.setSynthesisBus(bus);
    improvementScheduler.start().catch(err => {
      logger.warn(`[daemon] Improvement scheduler failed: ${err instanceof Error ? err.message : err}`);
    });

    // Runtime skill loader: hot-loads synthesized code skills from
    // <dataDir>/skills/*.ts into the runtime tool registry so the
    // orchestrator sees them on the next chat turn without a daemon
    // restart. Opt-in: default ON for "default", off for any other
    // workspace unless OHWOW_ENABLE_SYNTHESIS=1 is set, so a parallel
    // session (avenued) doesn't accidentally hot-load tools from its
    // own skills dir.
    const synthEnv = process.env.OHWOW_ENABLE_SYNTHESIS;
    const synthesisEnabled =
      synthEnv === '1' || (synthEnv !== '0' && activeWsName === 'default');
    if (synthesisEnabled) {
      const layout = resolveActiveWorkspace();
      const runtimeSkillLoader = new RuntimeSkillLoader({
        skillsDir: layout.skillsDir,
        compiledDir: layout.compiledSkillsDir,
        db,
        workspaceId,
      });
      runtimeSkillLoader.start().catch(err => {
        logger.warn(`[daemon] Runtime skill loader failed: ${err instanceof Error ? err.message : err}`);
      });
      bus.once('shutdown', () => runtimeSkillLoader.stop());
      logger.info(`[daemon] Runtime skill loader started (skillsDir=${layout.skillsDir})`);

      // Failure detector: scans for high-token zero-output tasks and
      // emits synthesis:candidate events on the bus. M5's generator
      // subscribes; the detector itself is intentionally dumb.
      const failureDetector = new SynthesisFailureDetector({
        db,
        workspaceId,
        bus,
      });
      failureDetector.start().catch(err => {
        logger.warn(`[daemon] Synthesis failure detector failed: ${err instanceof Error ? err.message : err}`);
      });
      bus.once('shutdown', () => failureDetector.stop());

      // Autolearner: subscribes to the detector's events and drives
      // the probe → generate → test pipeline automatically. Gated
      // behind OHWOW_ENABLE_AUTO_LEARNING=1 on top of the synthesis
      // flag so it stays opt-in for launch eve. When disabled the
      // class logs and returns without subscribing.
      if (isAutoLearningEnabled() && modelRouter && orchestrator) {
        const autoLearnerCtx: import('../orchestrator/local-tool-types.js').LocalToolContext = {
          db,
          workspaceId,
          engine: engineRef.current!,
          channels: channelRegistry,
          controlPlane,
          modelRouter,
        };
        const autoLearner = new SynthesisAutoLearner({
          bus,
          db,
          workspaceId,
          modelRouter,
          toolCtx: autoLearnerCtx,
        });
        autoLearner.start();
        bus.once('shutdown', () => autoLearner.stop());
      } else {
        logger.info('[daemon] Synthesis autolearner disabled (OHWOW_ENABLE_AUTO_LEARNING=1 to enable)');
      }
    } else {
      logger.info(`[daemon] Runtime skill loader disabled for workspace "${activeWsName}"`);
    }

    // Inner thoughts loop + presence engine: ambient awareness for proactive greetings
    const orchWorkspace = orchestrator?.getBrain()?.workspace;
    if (orchWorkspace) {
      const innerThoughts = new InnerThoughtsLoop(db, orchWorkspace, modelRouter, workspaceId);
      innerThoughts.start();

      const presenceEngine = new PresenceEngine({
        innerThoughts,
        workspace: orchWorkspace,
        modelRouter,
        db,
        workspaceId,
      });

      // Wire presence events from control plane (cloud → local dispatch)
      if (controlPlane) {
        controlPlane.setPresenceHandler((event) => {
          presenceEngine.handlePresenceEvent(event);
        });
      }

      // Wire presence events from local API route (direct, no cloud)
      bus.on('presence:event', (event) => {
        presenceEngine.handlePresenceEvent(event);
      });

      // Register as a body organ (the agent's "eye")
      digitalBody.setOrgan('eye', {
        id: 'eye',
        name: 'Eye (Presence)',
        domain: 'digital' as const,
        isActive: () => presenceEngine.isActive(),
        getHealth: () => presenceEngine.isActive() ? 'healthy' as const : 'dormant' as const,
        getAffordances: () => [],
        getUmwelt: () => [{
          modality: 'user_presence',
          organId: 'eye',
          currentValue: presenceEngine.getState(),
          lastUpdated: presenceEngine.getLastDetection() || Date.now(),
          updateFrequencyMs: 3000,
        }],
      });
    }

    // Connector sync scheduler: periodically syncs data source connectors
    connectorSyncScheduler = new ConnectorSyncScheduler(db, workspaceId, connectorRegistry, bus);
    connectorSyncScheduler.start();

    // Heart: every 15 min, aggregate task costs + (optionally) Stripe
    // MRR into business_vitals. Homeostasis reads the latest row to
    // set revenue_vs_burn pressure. No Stripe key = cost-only rows.
    const businessVitalsScheduler = new BusinessVitalsScheduler(db, workspaceId);
    businessVitalsScheduler.start();

    // Eyes reflex: every 5 min, tail provider logs named in
    // OHWOW_LOG_TAIL_WATCH (supabase,vercel,fly,modal) and write a
    // self_findings warning row when error_density exceeds threshold.
    // Unset env = watcher runs but every tick is a no-op.
    const logTailWatcher = new LogTailWatcher(db);
    logTailWatcher.start();
  }

  // 12a2. Document processing worker (runs on all devices)
  const documentWorker = new DocumentWorker(db, bus, {
    ollamaUrl: config.ollamaUrl,
    embeddingModel: config.embeddingModel || undefined,
    ollamaModel: config.ollamaModel || undefined,
  });
  documentWorker.start();

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

  // Consolidated inference status endpoint (provider, VRAM, switch state)
  app.get('/api/inference/status', (_req, res) => {
    const capacity = processMonitor.estimateCapacity();
    const mlxRunning = mlxEnabled && mlxManager !== null;
    const llamaCppRunning = llamaCppManager !== null && llamaCppUrl !== undefined;

    res.json({
      activeProvider: mlxRunning ? 'mlx' : llamaCppRunning ? 'llama-cpp' : 'ollama',
      mlx: mlxRunning ? { url: mlxManager!.getUrl(), model: mlxManager!.getModel() } : null,
      llamaCpp: llamaCppRunning ? { url: llamaCppUrl } : null,
      switchInProgress: modelSwitchInProgress,
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
    if (!mlxManager) {
      res.status(404).json({ error: 'MLX server not running' });
      return;
    }
    try {
      await mlxManager.unloadModel();
      dedicatedServerVramGB = 0;
      processMonitor.unregisterExternalProcess('mlx');
      bus.emit('inference:capabilities-changed', (await import('../lib/inference-capabilities.js')).createDefaultCapabilities());
      res.json({ data: { unloaded: true } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unload failed' });
    }
  });

  // TurboQuant capabilities endpoint
  app.get('/api/turboquant/status', (_req, res) => {
    const caps = mlxManager?.getCapabilities() ?? llamaCppManager?.getCapabilities() ?? null;
    res.json({
      active: caps?.turboQuantActive ?? false,
      bits: caps?.turboQuantBits ?? 0,
      cacheTypeK: caps?.cacheTypeK ?? null,
      cacheTypeV: caps?.cacheTypeV ?? null,
      provider: caps?.provider ?? 'ollama',
      llamaServerRunning: llamaCppManager ? true : false,
      mlxServerRunning: mlxManager ? true : false,
      mlxModel: mlxManager?.getModel() ?? null,
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
      modelReady: ollamaStatus || config.modelSource === 'cloud' || !!config.anthropicApiKey || !!config.openRouterApiKey,
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
