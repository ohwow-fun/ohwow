/**
 * MLX Manager — Process lifecycle management for mlx-vlm server
 *
 * Manages launching, health checking, and stopping the mlx_vlm.server Python
 * process on Apple Silicon. Supports TurboQuant KV cache compression via
 * --kv-bits and --kv-quant-scheme flags.
 *
 * Follows the same pattern as llama-cpp-manager.ts for process spawning.
 */

import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { openSync, closeSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';
import type { CompressionBits } from './turboquant/types.js';
import type { InferenceCapabilities } from './inference-capabilities.js';
import { createMLXCapabilities } from './inference-capabilities.js';

const DEFAULT_PORT = 8090;
const DEFAULT_HOST = '127.0.0.1';
const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 180_000; // 3 minutes — MLX model downloads can be slow on first use
const SHUTDOWN_GRACE_MS = 5_000;

export interface MLXLaunchConfig {
  /** Python 3 executable path (e.g., 'python3') */
  pythonPath: string;
  /** HuggingFace model ID (e.g., 'mlx-community/gemma-4-e4b-it-4bit') */
  model: string;
  /** Port to listen on (--port) */
  port: number;
  /** Host to bind to (--host) */
  host: string;
  /** TurboQuant KV cache compression bits (2, 3, or 4). Omit to disable. */
  kvBits?: CompressionBits;
  /** KV quantization scheme (e.g., 'turboquant'). Required when kvBits is set. */
  kvQuantScheme?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class MLXManager {
  private process: ChildProcess | null = null;
  private config: MLXLaunchConfig | null = null;
  private logFd: number | null = null;
  private capabilities: InferenceCapabilities | null = null;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private restartCount = 0;
  private onCrash: (() => void) | null = null;

  /**
   * Build the CLI arguments array for mlx_vlm.server.
   */
  private buildArgs(config: MLXLaunchConfig): string[] {
    const args: string[] = [
      '-m', 'mlx_vlm.server',
      '--model', config.model,
      '--host', config.host,
      '--port', String(config.port),
    ];

    if (config.kvBits) {
      args.push('--kv-bits', String(config.kvBits));
    }
    if (config.kvQuantScheme) {
      args.push('--kv-quant-scheme', config.kvQuantScheme);
    }

    return args;
  }

  /**
   * Launch mlx_vlm.server with the given configuration.
   * Waits for the health endpoint to report ready before returning.
   */
  async start(config: MLXLaunchConfig): Promise<void> {
    if (this.process) {
      await this.stop();
    }

    this.config = config;
    const args = this.buildArgs(config);

    logger.info({
      python: config.pythonPath,
      model: config.model,
      kvBits: config.kvBits,
      port: config.port,
    }, '[mlx-manager] Starting mlx-vlm server');

    // Open log file for stdout/stderr
    const logDir = join(homedir(), '.ohwow', 'data');
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, 'mlx-vlm-server.log');
    try {
      this.logFd = openSync(logPath, 'a');
    } catch {
      this.logFd = null;
    }

    this.process = spawn(config.pythonPath, args, {
      detached: true,
      stdio: ['ignore', this.logFd ?? 'ignore', this.logFd ?? 'ignore'],
    });
    this.process.unref();

    this.process.on('error', (err: Error) => {
      logger.error({ err }, '[mlx-manager] mlx-vlm server process error');
      this.process = null;
    });

    this.process.on('exit', (code: number | null) => {
      if (code !== null && code !== 0) {
        logger.warn({ code }, '[mlx-manager] mlx-vlm server exited with non-zero code');
      }
      this.process = null;
    });

    // Wait for health check
    await this.waitForReady(`http://${config.host}:${config.port}`, HEALTH_TIMEOUT_MS);

    // Record confirmed capabilities
    if (config.kvBits) {
      const cacheType = `turboquant-${config.kvBits}bit`;
      this.capabilities = createMLXCapabilities(config.kvBits, cacheType, cacheType);
    }

    logger.info('[mlx-manager] mlx-vlm server is ready');

    // Start watchdog: monitors health every 30s, auto-restarts on crash (up to 3 times)
    this.startWatchdog();
  }

  /**
   * Set a callback to be invoked when mlx-vlm server crashes and auto-restart fails.
   */
  setOnCrash(cb: () => void): void {
    this.onCrash = cb;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogInterval = setInterval(async () => {
      if (!this.config || !this.process) return;

      const healthy = await this.isRunning();
      if (healthy) return;

      if (this.restartCount >= 3) {
        logger.error('[mlx-manager] mlx-vlm server crashed 3 times, giving up');
        this.stopWatchdog();
        this.capabilities = null;
        this.onCrash?.();
        return;
      }

      this.restartCount++;
      logger.warn({ attempt: this.restartCount }, '[mlx-manager] mlx-vlm server crashed, attempting restart');

      try {
        this.process = null;
        await this.start(this.config);
        this.restartCount = 0;
        logger.info('[mlx-manager] mlx-vlm server auto-restarted successfully');
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : err },
          '[mlx-manager] Auto-restart failed');
      }
    }, 30_000);
  }

  private stopWatchdog(): void {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  /**
   * Gracefully stop the mlx-vlm server process.
   * Sends SIGTERM, waits up to 5 seconds, then SIGKILL.
   */
  async stop(): Promise<void> {
    this.stopWatchdog();

    if (!this.process) return;

    const pid = this.process.pid;
    if (!pid) return;

    logger.info({ pid }, '[mlx-manager] Stopping mlx-vlm server');

    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      this.process = null;
      this.cleanup();
      return;
    }

    const exitPromise = new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
        resolve();
      }, SHUTDOWN_GRACE_MS);

      this.process?.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await exitPromise;
    this.process = null;
    this.cleanup();
  }

  private cleanup(): void {
    this.capabilities = null;
    if (this.logFd !== null) {
      try { closeSync(this.logFd); } catch { /* */ }
      this.logFd = null;
    }
  }

  /** Get the confirmed inference capabilities. */
  getCapabilities(): InferenceCapabilities | null {
    return this.capabilities;
  }

  /** Check if the mlx-vlm server process is alive and healthy. */
  async isRunning(): Promise<boolean> {
    if (!this.process || !this.config) return false;

    try {
      const url = `http://${this.config.host}:${this.config.port}/health`;
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Get the URL this mlx-vlm server instance is serving on. */
  getUrl(): string {
    if (!this.config) return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
    return `http://${this.config.host}:${this.config.port}`;
  }

  /** Get the model currently loaded. */
  getModel(): string | null {
    return this.config?.model ?? null;
  }

  /**
   * Poll the health endpoint until the server reports ready.
   */
  private async waitForReady(baseUrl: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) return;
      } catch {
        // Server not up yet
      }

      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        throw new Error(`mlx-vlm server exited with code ${this.process.exitCode} during startup`);
      }

      await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    throw new Error(`mlx-vlm server did not become ready within ${timeoutMs / 1000} seconds`);
  }

  /**
   * Check if mlx-vlm is installed and available.
   */
  static checkAvailable(pythonPath = 'python3'): boolean {
    try {
      execSync(`${pythonPath} -c "import mlx_vlm"`, {
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install mlx-vlm via pip.
   */
  static async installMLXVLM(pythonPath = 'python3'): Promise<void> {
    logger.info('[mlx-manager] Installing mlx-vlm via pip');
    try {
      execSync(`${pythonPath} -m pip install -U mlx-vlm`, {
        timeout: 300_000, // 5 min for install
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      logger.info('[mlx-manager] mlx-vlm installed successfully');
    } catch (err) {
      throw new Error(`Failed to install mlx-vlm: ${err instanceof Error ? err.message : err}`);
    }
  }
}
