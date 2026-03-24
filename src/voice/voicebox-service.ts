/**
 * VoiceboxService — Managed Python Sidecar
 *
 * Spawns and manages the Voicebox FastAPI server (Whisper STT + TTS).
 * Follows the same lifecycle pattern as ScraplingService:
 * lazy start, health check, graceful shutdown.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';
import { findPythonCommand, findPipCommand } from '../lib/platform-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8000;
const STARTUP_TIMEOUT_MS = 60000; // Whisper model loading can be slow
const HEALTH_CHECK_INTERVAL_MS = 500;

export interface VoiceboxServiceConfig {
  port?: number;
  serverPath?: string;
}

export class VoiceboxService {
  private process: ChildProcess | null = null;
  private port: number;
  private baseUrl: string;
  private startPromise: Promise<void> | null = null;
  private serverPath: string;

  constructor(config: VoiceboxServiceConfig = {}) {
    this.port = config.port || parseInt(process.env.VOICEBOX_PORT || '', 10) || DEFAULT_PORT;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.serverPath = config.serverPath || join(__dirname, '..', '..', 'voicebox-server');
  }

  /** Get the base URL for API calls. */
  getBaseUrl(): string {
    return this.baseUrl;
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
        'Python not found (tried python3 and python). Install Python 3.8+ to use Voicebox.'
      );
    }

    // Check if an existing server is already healthy on this port
    if (await this.healthCheck()) {
      logger.info(`[Voicebox] Server already running on port ${this.port}, reusing`);
      return;
    }

    // Ensure server deps are installed
    await this.ensureDepsInstalled();

    // Buffer stderr during startup for port-in-use detection
    let stderrBuffer = '';
    let portInUseDetected = false;

    this.process = spawn(pythonCmd, [
      '-m', 'uvicorn',
      'server:app',
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--log-level', 'warning',
    ], {
      cwd: this.serverPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
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
        logger.error(`[Voicebox] ${trimmed}`);
      }
    });

    this.process.on('exit', (code) => {
      logger.info(`[Voicebox] Server exited with code ${code}`);
      this.process = null;
    });

    this.process.on('error', (err) => {
      logger.error(`[Voicebox] Server process error: ${err.message}`);
      this.process = null;
    });

    // Wait for health check to pass
    const startTime = Date.now();
    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      // Fast fail on port-in-use
      if (portInUseDetected) {
        this.kill();
        throw new Error(
          `Port ${this.port} is already in use. Set VOICEBOX_PORT to use a different port.`
        );
      }

      // Fast fail if process already exited
      if (!this.process) {
        throw new Error(
          `Voicebox server process exited during startup. ${stderrBuffer.slice(0, 500)}`
        );
      }

      if (await this.healthCheck()) {
        logger.info(`[Voicebox] Server ready on port ${this.port}`);
        return;
      }
      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }

    // Timeout — kill the process
    this.kill();
    throw new Error(`Voicebox server did not start within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }

  /** Stop the server gracefully. */
  async stop(): Promise<void> {
    if (!this.process) return;

    return new Promise<void>((resolve) => {
      const proc = this.process!;
      const timeout = setTimeout(() => {
        logger.warn('[Voicebox] Force-killing server after timeout');
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
      if (!res.ok) return false;
      const data = await res.json() as { status: string };
      return data.status === 'ok' || data.status === 'healthy';
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

  /** Ensure Python dependencies are installed. */
  private async ensureDepsInstalled(): Promise<void> {
    const pythonCmd = findPythonCommand();
    if (!pythonCmd) {
      throw new Error('Python not found (tried python3 and python). Install Python 3.8+ to use Voicebox.');
    }
    try {
      execFileSync(pythonCmd, ['-c', 'import fastapi; import uvicorn; import whisper'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
    } catch {
      const pipCmd = findPipCommand();
      if (!pipCmd) {
        throw new Error('pip not found (tried pip3 and pip). Install Python 3 with pip to use Voicebox.');
      }
      logger.info('[Voicebox] Installing server dependencies...');
      const requirementsPath = join(this.serverPath, 'requirements.txt');
      execFileSync(pipCmd, ['install', '-r', requirementsPath], {
        stdio: 'inherit',
        timeout: 600000, // 10 minutes (whisper + TTS can be large)
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
