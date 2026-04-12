/**
 * ScraplingService — Managed Python Sidecar
 *
 * Spawns and manages a Python FastAPI server that wraps Scrapling fetchers.
 * Follows the same lifecycle pattern as Ollama: lazy start, health check, graceful shutdown.
 */

import { spawn, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  ScraplingFetchOptions,
  ScraplingBulkFetchOptions,
  ScraplingResponse,
  ScraplingServiceConfig,
} from './scrapling-types.js';
import { ensureScraplingInstalled, ensureServerDepsInstalled } from '../../lib/scrapling-installer.js';
import { logger } from '../../lib/logger.js';
import { findPythonCommand } from '../../lib/platform-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8100;
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 500;

export class ScraplingService {
  private process: ChildProcess | null = null;
  private port: number;
  private baseUrl: string;
  private startPromise: Promise<void> | null = null;
  private serverPath: string;
  private proxyIndex = 0;
  private proxies: string[];

  constructor(config: ScraplingServiceConfig = {}) {
    this.port = config.port || DEFAULT_PORT;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.serverPath = config.serverPath || join(__dirname, '..', '..', '..', 'scrapling-server');
    this.proxies = config.proxies || (config.proxy ? [config.proxy] : []);
  }

  /** Start the Python subprocess. Uses a promise latch to prevent concurrent spawns. */
  async start(): Promise<void> {
    if (this.process) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** Actual start logic, called via the promise latch. */
  private async doStart(): Promise<void> {
    // Pre-flight: check that python3 or python is available
    const pythonCmd = findPythonCommand();
    if (!pythonCmd) {
      throw new Error(
        'Python not found (tried python3 and python). Install Python 3.8+ to use web scraping tools.'
      );
    }

    // Check if an existing server is already healthy on this port (another process)
    if (await this.healthCheck()) {
      logger.info(`[Scrapling] Server already running on port ${this.port}, reusing`);
      return;
    }

    // Ensure scrapling and server deps are installed
    await ensureScraplingInstalled();
    const requirementsPath = join(this.serverPath, 'requirements.txt');
    await ensureServerDepsInstalled(requirementsPath);

    // Buffer stderr during startup for port-in-use detection
    let stderrBuffer = '';
    let portInUseDetected = false;

    // Spawn with an explicit augmented PATH: if the daemon started with a
    // stripped PATH (e.g. via a nohup-ed launcher), inheriting process.env
    // is not enough and child processes that exec other binaries by name
    // (pip, scrapling, playwright install) fail with ENOENT. Prepend the
    // directory containing pythonCmd (which is now an absolute path) plus
    // common bin directories so sub-spawned tools still find their
    // siblings.
    const { dirname: pathDirname } = await import('path');
    const pythonDir = pathDirname(pythonCmd);
    const extraPathDirs = [pythonDir, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
    const augmentedPath = Array.from(
      new Set([...extraPathDirs, ...(process.env.PATH ?? '').split(':').filter(Boolean)]),
    ).join(':');

    this.process = spawn(pythonCmd, [
      '-m', 'uvicorn',
      'server:app',
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--log-level', 'warning',
    ], {
      cwd: this.serverPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: augmentedPath },
    });

    // Capture stderr for debugging and port-in-use detection
    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      stderrBuffer += msg;

      if (msg.toLowerCase().includes('address already in use') ||
          msg.toLowerCase().includes('port is already in use')) {
        portInUseDetected = true;
      }

      const trimmed = msg.trim();
      if (trimmed && !trimmed.includes('INFO:')) {
        logger.error(`[Scrapling] ${trimmed}`);
      }
    });

    this.process.on('exit', (code) => {
      logger.info(`[Scrapling] Server exited with code ${code}`);
      this.process = null;
    });

    this.process.on('error', (err) => {
      logger.error(`[Scrapling] Server process error: ${err.message}`);
      this.process = null;
    });

    // Wait for health check to pass
    const startTime = Date.now();
    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      // Fast fail on port-in-use
      if (portInUseDetected) {
        this.kill();
        throw new Error(
          `Port ${this.port} is already in use. Set OHWOW_SCRAPLING_PORT to use a different port.`
        );
      }

      // Fast fail if process already exited
      if (!this.process) {
        throw new Error(
          `Scrapling server process exited during startup. ${stderrBuffer.slice(0, 500)}`
        );
      }

      if (await this.healthCheck()) {
        logger.info(`[Scrapling] Server ready on port ${this.port}`);
        return;
      }
      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }

    // Timeout — kill the process
    this.kill();
    throw new Error(`Scrapling server did not start within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }

  /** Stop the server gracefully. */
  async stop(): Promise<void> {
    if (!this.process) return;

    return new Promise<void>((resolve) => {
      const proc = this.process!;
      const timeout = setTimeout(() => {
        logger.warn('[Scrapling] Force-killing server after timeout');
        proc.kill('SIGKILL');
        this.process = null;
        resolve();
      }, 5000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        resolve();
      });

      // Close stdin first — uvicorn detects EOF and shuts down gracefully
      proc.stdin?.end();
      proc.kill('SIGTERM');
    });
  }

  /** Force kill without waiting. */
  private kill(): void {
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }

  /** Check if the server is healthy. */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Ensure the server is running, starting it if needed. Recovers from zombie processes. */
  async ensureRunning(): Promise<void> {
    if (this.process && await this.healthCheck()) return;
    if (this.process) this.kill(); // Kill zombie/unresponsive process
    await this.start();
  }

  /** Get the next proxy from the rotation list. */
  private getNextProxy(): string | undefined {
    if (this.proxies.length === 0) return undefined;
    const proxy = this.proxies[this.proxyIndex % this.proxies.length];
    this.proxyIndex++;
    return proxy;
  }

  // -------------------------------------------------------------------------
  // Fetch methods
  // -------------------------------------------------------------------------

  /** Fast HTTP fetch with TLS impersonation. */
  async fetch(url: string, opts?: ScraplingFetchOptions): Promise<ScraplingResponse> {
    await this.ensureRunning();
    return this.post('/fetch', {
      url,
      selector: opts?.selector,
      timeout: opts?.timeout || 30,
      proxy: opts?.proxy || this.getNextProxy(),
      headless: opts?.headless,
    });
  }

  /** Stealth fetch using Camoufox (bypasses Cloudflare). */
  async stealthFetch(url: string, opts?: ScraplingFetchOptions): Promise<ScraplingResponse> {
    await this.ensureRunning();
    return this.post('/stealth-fetch', {
      url,
      selector: opts?.selector,
      timeout: opts?.timeout || 30,
      proxy: opts?.proxy || this.getNextProxy(),
      headless: opts?.headless,
    });
  }

  /** Dynamic fetch with full browser JS rendering. */
  async dynamicFetch(url: string, opts?: ScraplingFetchOptions): Promise<ScraplingResponse> {
    await this.ensureRunning();
    return this.post('/dynamic-fetch', {
      url,
      selector: opts?.selector,
      timeout: opts?.timeout || 30,
      proxy: opts?.proxy || this.getNextProxy(),
      headless: opts?.headless,
    });
  }

  /** Bulk fetch multiple URLs concurrently with fast HTTP. */
  async bulkFetch(urls: string[], opts?: ScraplingBulkFetchOptions): Promise<ScraplingResponse[]> {
    await this.ensureRunning();
    return this.post('/bulk-fetch', {
      urls,
      selector: opts?.selector,
      timeout: opts?.timeout || 30,
      proxy: opts?.proxy || this.getNextProxy(),
      headless: opts?.headless,
    });
  }

  /** Bulk fetch with stealth browser. */
  async bulkStealthFetch(urls: string[], opts?: ScraplingBulkFetchOptions): Promise<ScraplingResponse[]> {
    await this.ensureRunning();
    return this.post('/bulk-stealth-fetch', {
      urls,
      selector: opts?.selector,
      timeout: opts?.timeout || 30,
      proxy: opts?.proxy || this.getNextProxy(),
      headless: opts?.headless,
    });
  }

  // -------------------------------------------------------------------------
  // Internal HTTP client
  // -------------------------------------------------------------------------

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000), // 2 min overall timeout
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Scrapling server returned ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
