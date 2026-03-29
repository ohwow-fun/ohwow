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
import { existsSync, openSync, closeSync, mkdirSync, writeFileSync, chmodSync, createWriteStream, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, platform, arch } from 'os';
import { pipeline } from 'stream/promises';
import { logger } from './logger.js';
import type { CompressionBits } from './turboquant/types.js';
import type { InferenceCapabilities } from './inference-capabilities.js';
import { createLlamaCppCapabilities } from './inference-capabilities.js';

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
  private capabilities: InferenceCapabilities | null = null;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private restartCount = 0;
  private onCrash: (() => void) | null = null;

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

    // Record confirmed capabilities — we set the flags, so we know them
    const bits = this.inferBitsFromCacheType(config.cacheTypeK);
    if (bits) {
      this.capabilities = createLlamaCppCapabilities(bits, config.cacheTypeK, config.cacheTypeV);
    }

    logger.info('[llama-cpp-manager] llama-server is ready');

    // Start watchdog: monitors health every 30s, auto-restarts on crash (up to 3 times)
    this.startWatchdog();
  }

  /**
   * Set a callback to be invoked when llama-server crashes and auto-restart fails.
   * Use this to emit capabilities-changed events to the bus.
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

      // Process died — attempt auto-restart
      if (this.restartCount >= 3) {
        logger.error('[llama-cpp-manager] llama-server crashed 3 times, giving up');
        this.stopWatchdog();
        this.capabilities = null;
        this.onCrash?.();
        return;
      }

      this.restartCount++;
      logger.warn({ attempt: this.restartCount }, '[llama-cpp-manager] llama-server crashed, attempting restart');

      try {
        this.process = null; // Clear dead process ref
        await this.start(this.config);
        this.restartCount = 0; // Reset on successful restart
        logger.info('[llama-cpp-manager] llama-server auto-restarted successfully');
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : err },
          '[llama-cpp-manager] Auto-restart failed');
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
   * Gracefully stop the llama-server process.
   * Sends SIGTERM, waits up to 5 seconds, then SIGKILL.
   */
  async stop(): Promise<void> {
    this.stopWatchdog();

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
    this.capabilities = null;
    if (this.logFd !== null) {
      try { closeSync(this.logFd); } catch { /* */ }
      this.logFd = null;
    }
  }

  /**
   * Get the confirmed inference capabilities.
   * Returns null if llama-server is not running or hasn't started.
   */
  getCapabilities(): InferenceCapabilities | null {
    return this.capabilities;
  }

  /** Infer compression bits from cache type string. */
  private inferBitsFromCacheType(cacheType: string): 2 | 3 | 4 | null {
    if (cacheType === 'turbo2') return 2;
    if (cacheType === 'turbo3') return 3;
    if (cacheType === 'turbo4') return 4;
    return null;
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
   * Find or download the llama-server binary.
   *
   * Search order:
   * 1. Explicit config path
   * 2. ~/.ohwow/bin/llama-server (previously downloaded)
   * 3. System PATH
   * 4. Auto-download from GitHub releases
   *
   * The auto-download fetches a prebuilt binary for the current platform
   * from the llama.cpp releases (or turboquant fork when available).
   */
  static async ensureBinary(configBinaryPath?: string): Promise<string> {
    // 1. Explicit config path
    if (configBinaryPath && existsSync(configBinaryPath)) {
      return configBinaryPath;
    }

    // 2. ohwow bin directory
    const ohwowBinDir = join(homedir(), '.ohwow', 'bin');
    const ohwowBin = join(ohwowBinDir, 'llama-server');
    if (existsSync(ohwowBin)) return ohwowBin;

    // 3. System PATH
    try {
      const whichCmd = platform() === 'win32' ? 'where llama-server' : 'which llama-server';
      const which = execSync(whichCmd, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
      const foundPath = which.toString().trim().split('\n')[0];
      if (foundPath && existsSync(foundPath)) return foundPath;
    } catch {
      // Not in PATH
    }

    // 4. Auto-download
    logger.info('[llama-cpp-manager] llama-server not found, attempting auto-download');
    return LlamaCppManager.downloadBinary(ohwowBinDir);
  }

  /**
   * Download a prebuilt llama-server binary from GitHub releases.
   * Fetches the latest release, finds the asset for the current platform,
   * downloads and extracts it to the target directory.
   */
  private static async downloadBinary(targetDir: string): Promise<string> {
    const os = platform();
    const cpuArch = arch();

    // Map to llama.cpp release asset naming conventions
    const platformKey = LlamaCppManager.getPlatformKey(os, cpuArch);
    if (!platformKey) {
      throw new Error(
        `No prebuilt llama-server available for ${os}-${cpuArch}. ` +
        'Build from source: https://github.com/ggml-org/llama.cpp#build',
      );
    }

    // Fetch latest release info from llama.cpp (or turboquant fork)
    const releaseUrl = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
    logger.info({ url: releaseUrl }, '[llama-cpp-manager] Fetching latest release info');

    const releaseRes = await fetch(releaseUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'ohwow-runtime' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!releaseRes.ok) {
      throw new Error(`GitHub API returned ${releaseRes.status} fetching release info`);
    }

    const release = await releaseRes.json() as {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string; size: number }>;
    };

    // Find the matching asset for this platform
    const asset = release.assets.find(a => a.name.includes(platformKey) && a.name.endsWith('.zip'));
    if (!asset) {
      const available = release.assets.map(a => a.name).join(', ');
      throw new Error(
        `No llama-server binary found for ${platformKey} in release ${release.tag_name}. ` +
        `Available assets: ${available}`,
      );
    }

    logger.info({ asset: asset.name, size: asset.size, release: release.tag_name },
      '[llama-cpp-manager] Downloading llama-server binary');

    // Download the zip
    const downloadRes = await fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(300_000), // 5 min timeout for large files
      headers: { 'User-Agent': 'ohwow-runtime' },
    });

    if (!downloadRes.ok || !downloadRes.body) {
      throw new Error(`Download failed: ${downloadRes.status}`);
    }

    // Ensure target directory exists
    mkdirSync(targetDir, { recursive: true });

    // Write zip to temp file
    const zipPath = join(targetDir, `llama-server-${release.tag_name}.zip`);
    const fileStream = createWriteStream(zipPath);
    // Convert web ReadableStream to Node.js stream via Readable.fromWeb
    const { Readable } = await import('stream');
    const nodeStream = Readable.fromWeb(downloadRes.body as import('stream/web').ReadableStream);
    await pipeline(nodeStream, fileStream);

    // Extract llama-server binary from the zip
    const targetBin = join(targetDir, 'llama-server');
    try {
      // Use unzip CLI (available on macOS and most Linux)
      execSync(`unzip -o -j "${zipPath}" "*/llama-server" -d "${targetDir}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      });

      if (!existsSync(targetBin)) {
        // Try alternative: some zips have the binary at root level
        execSync(`unzip -o -j "${zipPath}" "llama-server" -d "${targetDir}"`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        });
      }
    } catch {
      throw new Error(
        `Failed to extract llama-server from ${zipPath}. ` +
        'You may need to install unzip or extract manually.',
      );
    } finally {
      // Clean up zip
      try { unlinkSync(zipPath); } catch { /* */ }
    }

    if (!existsSync(targetBin)) {
      throw new Error(`llama-server binary not found after extracting ${asset.name}`);
    }

    // Make executable
    chmodSync(targetBin, 0o755);
    logger.info({ path: targetBin, release: release.tag_name },
      '[llama-cpp-manager] llama-server binary installed');

    return targetBin;
  }

  /**
   * Map OS/arch to the llama.cpp release asset naming convention.
   * Returns null if no prebuilt binary is available.
   */
  private static getPlatformKey(os: string, cpuArch: string): string | null {
    if (os === 'darwin' && cpuArch === 'arm64') return 'macos-arm64';
    if (os === 'darwin' && cpuArch === 'x64') return 'macos-x64';
    if (os === 'linux' && cpuArch === 'x64') return 'linux-x64';
    if (os === 'linux' && cpuArch === 'arm64') return 'linux-arm64';
    if (os === 'win32' && cpuArch === 'x64') return 'win-x64';
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
