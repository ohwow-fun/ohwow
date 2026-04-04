/**
 * Onboarding Service
 * Shared logic for both Web UI and TUI onboarding flows.
 * Handles device detection, Ollama lifecycle, model download, and config saving.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_DB_PATH,
  DEFAULT_PORT,
  DEFAULT_CLOUD_URL,
  isFirstRun,
} from '../config.js';
import type { RuntimeConfig } from '../config.js';
import { detectDevice } from './device-info.js';
import type { DeviceInfo, MemoryTier } from './device-info.js';
import { getMemoryTier, formatDeviceCompact } from './device-info.js';
import { primaryRecommendation, alternativeModels, estimateDownloadMinutes } from './ollama-models.js';
import type { OllamaModelInfo } from './ollama-models.js';
import {
  isOllamaInstalled,
  isOllamaRunning,
  startOllama,
  installOllama,
  pullModel,
  listInstalledModels,
  listRunningModels,
} from './ollama-installer.js';
import type { PullProgress } from './ollama-installer.js';

export interface OnboardingStatus {
  isFirstRun: boolean;
  device: DeviceInfo;
  deviceSummary: string;
  memoryTier: MemoryTier;
  recommendation: OllamaModelInfo | null;
  alternatives: OllamaModelInfo[];
  estimatedMinutes: number | null;
  ollamaInstalled: boolean;
  ollamaRunning: boolean;
  installedModels: string[];
  runningModels: string[];
}

export interface OnboardingProgress {
  phase: 'installing_ollama' | 'starting_ollama' | 'downloading_model';
  message: string;
  percent?: number;
  done?: boolean;
  error?: string;
}

export class OnboardingService {
  private device: DeviceInfo | null = null;

  /** Detect hardware and compute recommendations. */
  async initialize(): Promise<OnboardingStatus> {
    this.device = detectDevice();
    const memoryTier = getMemoryTier(this.device);
    const recommendation = primaryRecommendation(this.device);
    const alternatives = alternativeModels(this.device, recommendation?.tag);
    const ollamaInstalled = await isOllamaInstalled();
    const ollamaRunning = ollamaInstalled ? await isOllamaRunning() : false;

    const installedModels = ollamaRunning ? await listInstalledModels() : [];
    const runningModels = ollamaRunning ? await listRunningModels() : [];

    return {
      isFirstRun: isFirstRun(),
      device: this.device,
      deviceSummary: formatDeviceCompact(this.device),
      memoryTier,
      recommendation,
      alternatives,
      estimatedMinutes: recommendation ? estimateDownloadMinutes(recommendation.sizeGB) : null,
      ollamaInstalled,
      ollamaRunning,
      installedModels,
      runningModels,
    };
  }

  /** Ensure Ollama is installed and running. Yields progress events. */
  async *ensureOllama(): AsyncGenerator<OnboardingProgress> {
    const device = this.device || detectDevice();

    // Install if needed
    const installed = await isOllamaInstalled();
    if (!installed) {
      yield { phase: 'installing_ollama', message: 'Installing Ollama...' };
      try {
        for await (const line of installOllama(device.platform)) {
          yield { phase: 'installing_ollama', message: line };
        }
        yield { phase: 'installing_ollama', message: 'Ollama installed', done: true };
      } catch (err) {
        yield {
          phase: 'installing_ollama',
          message: err instanceof Error ? err.message : 'Install failed',
          error: err instanceof Error ? err.message : 'Install failed',
        };
        return;
      }
    }

    // Start if needed
    const running = await isOllamaRunning();
    if (!running) {
      yield { phase: 'starting_ollama', message: 'Starting Ollama...' };
      try {
        await startOllama();
        yield { phase: 'starting_ollama', message: 'Ollama is running', done: true };
      } catch (err) {
        yield {
          phase: 'starting_ollama',
          message: err instanceof Error ? err.message : 'Could not start Ollama',
          error: err instanceof Error ? err.message : 'Could not start Ollama',
        };
        return;
      }
    } else {
      yield { phase: 'starting_ollama', message: 'Ollama is already running', done: true };
    }
  }

  /** Download a model. Yields progress events. */
  async *downloadModel(tag: string): AsyncGenerator<OnboardingProgress> {
    // Check if already downloaded
    const installed = await listInstalledModels();
    const tagBase = tag.split(':')[0];
    const tagVariant = tag.split(':')[1] || '';
    if (installed.some(m => m.startsWith(tagBase) && m.includes(tagVariant))) {
      yield { phase: 'downloading_model', message: 'Model already downloaded', percent: 100, done: true };
      return;
    }

    yield { phase: 'downloading_model', message: 'Starting download...', percent: 0 };

    try {
      let lastProgress: PullProgress | null = null;
      for await (const progress of pullModel(tag)) {
        lastProgress = progress;
        yield {
          phase: 'downloading_model',
          message: progress.status,
          percent: progress.percent,
        };
      }
      yield {
        phase: 'downloading_model',
        message: lastProgress?.status || 'Download complete',
        percent: 100,
        done: true,
      };
    } catch (err) {
      yield {
        phase: 'downloading_model',
        message: err instanceof Error ? err.message : 'Download failed',
        error: err instanceof Error ? err.message : 'Download failed',
      };
    }
  }

  /** Save free tier config. Returns the created config. */
  saveFreeTierConfig(modelTag: string, configPath?: string): RuntimeConfig {
    const config: RuntimeConfig = {
      licenseKey: '',
      cloudUrl: DEFAULT_CLOUD_URL,
      anthropicApiKey: '',
      modelSource: 'local',
      cloudModel: 'claude-haiku-4-5-20251001',
      anthropicOAuthToken: '',
      port: DEFAULT_PORT,
      dbPath: DEFAULT_DB_PATH,
      jwtSecret: '',
      localUrl: `http://localhost:${DEFAULT_PORT}`,
      browserHeadless: false,
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: modelTag,
      preferLocalModel: true,
      orchestratorModel: '',
      quickModel: '',
      ocrModel: '',
      openRouterApiKey: '',
      openRouterModel: 'openrouter/optimus-alpha',
      scraplingPort: 8100,
      scraplingAutoStart: true,
      scraplingProxy: '',
      scraplingProxies: [],
      onboardingComplete: true,
      agentSetupComplete: false,
      firstChatCompleted: false,
      tunnelEnabled: false,
      skipMediaCostConfirmation: false,
      tier: 'free',
      deviceRole: 'hybrid',
      workspaceGroup: 'default',
      mcpServers: [],
      mcpServerEnabled: false,
      openclaw: {
        enabled: false,
        binaryPath: '',
        allowlistedSkills: [],
        rateLimitPerMinute: 10,
        rateLimitPerHour: 100,
        sandboxAllowNetwork: false,
        maxExecutionTimeMs: 30_000,
      },
      turboQuantBits: 0,
      llamaCppUrl: 'http://localhost:8085',
      llamaCppBinaryPath: '',
      llamaCppModelPath: '',
      mlxEnabled: false,
      mlxServerUrl: 'http://localhost:8090',
      mlxModel: '',
      claudeCodeCliPath: '',
      claudeCodeCliModel: '',
      claudeCodeCliMaxTurns: 25,
      claudeCodeCliPermissionMode: 'skip',
      claudeCodeCliAutodetect: true,
      embeddingModel: 'nomic-embed-text',
      ragBm25Weight: 0.5,
      rerankerEnabled: false,
      openaiCompatibleUrl: '',
      openaiCompatibleApiKey: '',
    };

    const path = configPath || DEFAULT_CONFIG_PATH;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(config, null, 2));

    const dataDir = dirname(config.dbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    return config;
  }

  /** Check if this is a first run. */
  checkFirstRun(configPath?: string): boolean {
    return isFirstRun(configPath);
  }
}
