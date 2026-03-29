/**
 * LlamaCpp Manager — Process lifecycle management for llama-server
 *
 * Manages launching, health checking, and stopping the llama-server process
 * from TheTom's turboquant fork. Supports TurboQuant cache types
 * (turbo2/turbo3/turbo4) for real KV cache compression.
 *
 * Follows patterns from ollama-installer.ts for process spawning.
 */

import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { existsSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';
import type { CompressionBits } from './turboquant/types.js';

const DEFAULT_PORT = 8085;
const DEFAULT_HOST = '127.0.0.1';
const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 120_000; // 2 minutes for model loading
const SHUTDOWN_GRACE_MS = 5_000;

export interface LlamaCppLaunchConfig {
  /** Path to the llama-server binary */
  binaryPath: string;
  /** Path to the .gguf model file */
  modelPath: string;
  /** Context size in tokens (-c flag) */
  contextSize: number;
  /** KV cache type for keys (--cache-type-k) */
  cacheTypeK: string;
  /** KV cache type for values (--cache-type-v) */
  cacheTypeV: string;
  /** Number of GPU layers to offload (-ngl, 99 = all) */
  gpuLayers: number;
  /** Enable flash attention (-fa) */
  flashAttention: boolean;
  /** Port to listen on (--port) */
  port: number;
  /** Host to bind to (--host) */
  host: string;
  /** Number of parallel request slots (--parallel) */
  nParallel?: number;
}

export class LlamaCppManager {
  private process: ChildProcess | null = null;
  private config: LlamaCppLaunchConfig | null = null;
  private logFd: number | null = null;

  /**
   * Map TurboQuant compression bits to llama-server cache type names.
   * These correspond to GGML types in TheTom's turboquant fork.
   */
  static cacheTypeFromBits(bits: CompressionBits): string {
    switch (bits) {
      case 2: return 'turbo2';
      case 3: return 'turbo3';
      case 4: return 'turbo4';
    }
  }

  /**
   * Build the CLI arguments array for llama-server.
   */
  private buildArgs(config: LlamaCppLaunchConfig): string[] {
    const args: string[] = [
      '-m', config.modelPath,
      '-c', String(config.contextSize),
      '--host', config.host,
      '--port', String(config.port),
      '-ngl', String(config.gpuLayers),
    ];

    if (config.cacheTypeK) {
      args.push('--cache-type-k', config.cacheTypeK);
    }
    if (config.cacheTypeV) {
      args.push('--cache-type-v', config.cacheTypeV);
    }
    if (config.flashAttention) {
      args.push('-fa');
    }
    if (config.nParallel) {
      args.push('--parallel', String(config.nParallel));
    }

    return args;
  }

  /**
   * Launch llama-server with the given configuration.
   * Waits for the health endpoint to report ready before returning.
   */
  async start(config: LlamaCppLaunchConfig): Promise<void> {
    if (this.process) {
      await this.stop();
    }

    if (!existsSync(config.binaryPath)) {
      throw new Error(`llama-server binary not found at ${config.binaryPath}`);
    }
    if (!existsSync(config.modelPath)) {
      throw new Error(`GGUF model file not found at ${config.modelPath}`);
    }

    this.config = config;
    const args = this.buildArgs(config);

    logger.info({
      binary: config.binaryPath,
      model: config.modelPath,
      context: config.contextSize,
      cacheK: config.cacheTypeK,
      cacheV: config.cacheTypeV,
      port: config.port,
    }, '[llama-cpp-manager] Starting llama-server');

    // Open log file for stdout/stderr
    const logDir = join(homedir(), '.ohwow', 'data');
    const logPath = join(logDir, 'llama-cpp-server.log');
    try {
      this.logFd = openSync(logPath, 'a');
    } catch {
      // Log dir might not exist yet; fall back to /dev/null
      this.logFd = null;
    }

    this.process = spawn(config.binaryPath, args, {
      detached: true,
      stdio: ['ignore', this.logFd ?? 'ignore', this.logFd ?? 'ignore'],
    });
    this.process.unref();

    this.process.on('error', (err) => {
      logger.error({ err }, '[llama-cpp-manager] llama-server process error');
      this.process = null;
    });

    this.process.on('exit', (code) => {
      if (code !== null && code !== 0) {
        logger.warn({ code }, '[llama-cpp-manager] llama-server exited with non-zero code');
      }
      this.process = null;
    });

    // Wait for health check
    await this.waitForReady(`http://${config.host}:${config.port}`, HEALTH_TIMEOUT_MS);
    logger.info('[llama-cpp-manager] llama-server is ready');
  }

  /**
   * Gracefully stop the llama-server process.
   * Sends SIGTERM, waits up to 5 seconds, then SIGKILL.
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    const pid = this.process.pid;
    if (!pid) return;

    logger.info({ pid }, '[llama-cpp-manager] Stopping llama-server');

    // Send SIGTERM
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may already be dead
      this.process = null;
      this.cleanup();
      return;
    }

    // Wait for graceful exit
    const exitPromise = new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        // Force kill after grace period
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
    if (this.logFd !== null) {
      try { closeSync(this.logFd); } catch { /* */ }
      this.logFd = null;
    }
  }

  /**
   * Check if the llama-server process is alive and healthy.
   */
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

  /**
   * Get the URL this llama-server instance is serving on.
   */
  getUrl(): string {
    if (!this.config) return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
    return `http://${this.config.host}:${this.config.port}`;
  }

  /**
   * Poll the health endpoint until the server reports ready.
   * llama-server returns {"status":"loading model"} while loading,
   * then {"status":"ok"} (HTTP 200) when ready.
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

      // Check if process died
      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        throw new Error(`llama-server exited with code ${this.process.exitCode} during startup`);
      }

      await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    throw new Error(`llama-server did not become ready within ${timeoutMs / 1000} seconds`);
  }

  /**
   * Find the llama-server binary. Checks:
   * 1. ~/.ohwow/bin/llama-server
   * 2. System PATH (which llama-server)
   *
   * Returns the path if found, throws if not.
   */
  static async ensureBinary(configBinaryPath?: string): Promise<string> {
    // 1. Explicit config path
    if (configBinaryPath && existsSync(configBinaryPath)) {
      return configBinaryPath;
    }

    // 2. ohwow bin directory
    const ohwowBin = join(homedir(), '.ohwow', 'bin', 'llama-server');
    if (existsSync(ohwowBin)) return ohwowBin;

    // 3. System PATH
    try {
      const which = execSync('which llama-server', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
      const path = which.toString().trim();
      if (path && existsSync(path)) return path;
    } catch {
      // Not in PATH
    }

    throw new Error(
      'llama-server binary not found. To use TurboQuant KV cache compression, ' +
      'build llama-server from the turboquant fork:\n' +
      '  git clone https://github.com/TheTom/llama-cpp-turboquant.git\n' +
      '  cd llama-cpp-turboquant && git checkout feature/turboquant-kv-cache\n' +
      '  cmake -B build -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON && cmake --build build --target llama-server -j\n' +
      '  cp build/bin/llama-server ~/.ohwow/bin/llama-server',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
