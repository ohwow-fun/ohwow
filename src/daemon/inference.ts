/**
 * Daemon inference phase
 *
 * Chooses the local inference server (MLX on Apple Silicon, llama-cpp on
 * NVIDIA with TurboQuant, Ollama everywhere else), constructs the
 * ModelRouter, wires bus listeners for runtime model-switch events, warms
 * up the active Ollama model, and starts the OllamaMonitor + ProcessMonitor
 * background loops. Populates ctx.{modelRouter, mlxManager, llamaCppManager,
 * ollamaMonitor, processMonitor, warmupAbort} and returns an InferenceState
 * object carrying scalar state (mlxEnabled, llamaCppUrl, ollamaStatus, ...)
 * that later boot phases and HTTP status endpoints still read.
 */

import type { LlamaCppManager } from '../lib/llama-cpp-manager.js';
import type { MLXManager } from '../lib/mlx-manager.js';
import type { InferenceCapabilities } from '../lib/inference-capabilities.js';
import { MODEL_CATALOG } from '../lib/ollama-models.js';
import { ModelRouter } from '../execution/model-router.js';
import { OllamaMonitor } from '../lib/ollama-monitor.js';
import { ProcessMonitor } from '../lib/process-monitor.js';
import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';

export interface InferenceState {
  mainModelHasVision: boolean;
  mlxEnabled: boolean;
  mlxServerUrl: string | undefined;
  llamaCppUrl: string | undefined;
  inferenceCapabilities: InferenceCapabilities | null;
  /** Estimated VRAM used by the dedicated server (for capacity tracking). */
  dedicatedServerVramGB: number;
  ollamaStatus: boolean;
  ollamaAutoStartFailed: boolean;
  modelSwitchInProgress: boolean;
  handleModelSwitch: (newModel: string) => Promise<void>;
}

export async function setupInference(ctx: Partial<DaemonContext>): Promise<InferenceState> {
  const config = ctx.config!;
  const bus = ctx.bus!;
  const db = ctx.db!;

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

  const state: InferenceState = {
    mainModelHasVision,
    mlxEnabled: false,
    mlxServerUrl: undefined,
    llamaCppUrl: undefined,
    inferenceCapabilities: null,
    dedicatedServerVramGB: 0,
    ollamaStatus: false,
    ollamaAutoStartFailed: false,
    modelSwitchInProgress: false,
    handleModelSwitch: async () => {},
  };

  let llamaCppManager: LlamaCppManager | null = null;
  let mlxManager: MLXManager | null = null;

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
      state.mlxServerUrl = mlxManager.getUrl();
      state.mlxEnabled = true;
      state.dedicatedServerVramGB = modelSizeGB;

      if (kvBits) {
        const mlxCaps = mlxManager.getCapabilities();
        if (mlxCaps) state.inferenceCapabilities = mlxCaps;
      }

      mlxManager.setOnCrash(async () => {
        const { createDefaultCapabilities } = await import('../lib/inference-capabilities.js');
        const defaultCaps = createDefaultCapabilities();
        ctx.orchestrator?.setInferenceCapabilities(defaultCaps);
        bus.emit('inference:capabilities-changed', defaultCaps);
        state.dedicatedServerVramGB = 0;
        logger.warn('[daemon] mlx-vlm server permanently down, MLX disabled');
      });

      // Unload the same model from Ollama to free VRAM (best-effort)
      try {
        const { unloadModel } = await import('../lib/ollama-installer.js');
        await unloadModel(config.ollamaModel, config.ollamaUrl);
      } catch { /* Ollama may not be running or model not loaded */ }

      logger.info({ url: state.mlxServerUrl, model: mlxModelId, kvBits, provider: 'mlx' }, '[daemon] Started MLX inference (Apple Silicon native)');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[daemon] mlx-vlm not available, falling back to Ollama');
      mlxManager = null;
      state.mlxEnabled = false;
    }
  } else if (useMLX && !fitsInVram) {
    logger.warn({ modelSizeGB, totalVramGB, model: config.ollamaModel }, '[daemon] Model too large for dedicated MLX server, using Ollama');
  }

  if (useLlamaCpp && !state.mlxEnabled && fitsInVram) {
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
      state.llamaCppUrl = llamaCppManager.getUrl();
      state.inferenceCapabilities = llamaCppManager.getCapabilities();
      state.dedicatedServerVramGB = modelSizeGB;

      llamaCppManager.setOnCrash(async () => {
        const { createDefaultCapabilities } = await import('../lib/inference-capabilities.js');
        const defaultCaps = createDefaultCapabilities();
        ctx.orchestrator?.setInferenceCapabilities(defaultCaps);
        bus.emit('inference:capabilities-changed', defaultCaps);
        state.dedicatedServerVramGB = 0;
        logger.warn('[daemon] llama-server permanently down, TurboQuant disabled');
      });

      // Unload the same model from Ollama to free VRAM (best-effort)
      try {
        const { unloadModel } = await import('../lib/ollama-installer.js');
        await unloadModel(config.ollamaModel, config.ollamaUrl);
      } catch { /* Ollama may not be running or model not loaded */ }

      logger.info({ url: state.llamaCppUrl, bits: config.turboQuantBits, provider: 'llama-cpp' }, '[daemon] Started llama-server with TurboQuant');
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
    llamaCppUrl: state.llamaCppUrl,
    turboQuantBits: config.turboQuantBits,
    mlxServerUrl: state.mlxServerUrl,
    mlxEnabled: state.mlxEnabled,
    mlxModel: config.mlxModel || undefined,
    openaiCompatibleUrl: config.openaiCompatibleUrl || undefined,
    openaiCompatibleApiKey: config.openaiCompatibleApiKey || undefined,
    claudeCodeCliPath: config.claudeCodeCliPath || undefined,
    claudeCodeCliModel: config.claudeCodeCliModel || undefined,
  });

  // ---- Graceful model switching (serialized, memory-aware) ----
  state.handleModelSwitch = async function handleModelSwitch(newModel: string): Promise<void> {
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
      state.dedicatedServerVramGB = 0;

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
        state.dedicatedServerVramGB = newModelSizeGB;
        const caps = mlxManager.getCapabilities();
        if (caps) {
          ctx.orchestrator?.setInferenceCapabilities(caps);
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
        state.dedicatedServerVramGB = newModelSizeGB;
        const caps = llamaCppManager.getCapabilities();
        if (caps) {
          ctx.orchestrator?.setInferenceCapabilities(caps);
          bus.emit('inference:capabilities-changed', caps);
        }
        switchedProvider = 'llama-cpp';
        logger.info({ model: newModel }, '[daemon] llama-server restarted with new model');
      } else {
        // Fall back to Ollama (no dedicated server, or model too large)
        const { createDefaultCapabilities } = await import('../lib/inference-capabilities.js');
        const defaultCaps = createDefaultCapabilities();
        ctx.orchestrator?.setInferenceCapabilities(defaultCaps);
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
      ctx.orchestrator?.setInferenceCapabilities(defaultCaps);
      bus.emit('inference:capabilities-changed', defaultCaps);
      state.dedicatedServerVramGB = 0;
    }
  };

  // Update ModelRouter when user changes active model via the dashboard
  bus.on('ollama:model-changed', (payload: { model: string }) => {
    modelRouter.setOllamaModel(payload.model);
    logger.info(`[daemon] Active Ollama model changed to: ${payload.model}`);

    // Serialize model switches — don't start a new switch while one is in progress
    if (state.modelSwitchInProgress) {
      logger.warn({ model: payload.model }, '[daemon] Model switch already in progress, skipping');
      return;
    }
    state.modelSwitchInProgress = true;
    state.handleModelSwitch(payload.model).finally(() => {
      state.modelSwitchInProgress = false;
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
        state.ollamaAutoStartFailed = true;
      }
    }
    state.ollamaStatus = ollamaReady;
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
  if (state.mlxEnabled && mlxManager) {
    processMonitor.registerExternalProcess('mlx', mlxManager.getUrl(), state.dedicatedServerVramGB * 1024);
  }
  if (llamaCppManager && state.llamaCppUrl) {
    processMonitor.registerExternalProcess('llama-cpp', state.llamaCppUrl, state.dedicatedServerVramGB * 1024);
  }
  logger.info('[daemon] ProcessMonitor started');

  ctx.modelRouter = modelRouter;
  ctx.mlxManager = mlxManager;
  ctx.llamaCppManager = llamaCppManager;
  ctx.ollamaMonitor = ollamaMonitor;
  ctx.processMonitor = processMonitor;
  ctx.warmupAbort = warmupAbort;

  return state;
}
