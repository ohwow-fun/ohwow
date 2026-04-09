/**
 * Audio Capture Service
 * Node wrapper around the Swift ScreenCaptureKit helper.
 * Auto-compiles the Swift binary on first use.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, watch, readFileSync, type FSWatcher } from 'fs';
import { join, dirname } from 'path';
import { homedir, platform } from 'os';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../lib/logger.js';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FLAG_DIR = join(homedir(), '.ohwow');
const BIN_DIR = join(FLAG_DIR, 'bin');
const BINARY_PATH = join(BIN_DIR, 'ohwow-capture');
const COMPILED_FLAG = join(FLAG_DIR, 'capture-compiled');
const SWIFT_SOURCE = join(__dirname, '..', '..', 'src', 'audio-capture', 'capture.swift');

// ---------------------------------------------------------------------------
// Binary compilation (auto-compile on first use)
// ---------------------------------------------------------------------------

function isBinaryAvailable(): boolean {
  if (existsSync(COMPILED_FLAG) && existsSync(BINARY_PATH)) return true;
  return false;
}

export function ensureCaptureBinary(): boolean {
  if (platform() !== 'darwin') {
    logger.warn('[AudioCapture] System audio capture requires macOS');
    return false;
  }

  if (isBinaryAvailable()) return true;

  // Find the Swift source — check multiple locations (dev vs dist)
  const sourcePaths = [
    SWIFT_SOURCE,
    join(__dirname, 'capture.swift'),
    join(dirname(__dirname), 'audio-capture', 'capture.swift'),
  ];
  const source = sourcePaths.find(p => existsSync(p));
  if (!source) {
    logger.error('[AudioCapture] capture.swift not found');
    return false;
  }

  try {
    if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });

    logger.info('[AudioCapture] Compiling audio capture helper (first-time setup)...');
    execFileSync('swiftc', [
      source,
      '-o', BINARY_PATH,
      '-framework', 'ScreenCaptureKit',
      '-framework', 'CoreMedia',
      '-framework', 'AVFoundation',
      '-O',
    ], { stdio: 'pipe', timeout: 120_000 });

    if (existsSync(BINARY_PATH)) {
      if (!existsSync(FLAG_DIR)) mkdirSync(FLAG_DIR, { recursive: true });
      writeFileSync(COMPILED_FLAG, new Date().toISOString(), 'utf-8');
      logger.info('[AudioCapture] Capture helper compiled successfully');
      return true;
    }
  } catch (err) {
    logger.error({ err }, '[AudioCapture] Failed to compile capture helper. Ensure Xcode Command Line Tools are installed.');
  }

  return false;
}

// ---------------------------------------------------------------------------
// Audio Capture Events
// ---------------------------------------------------------------------------

export interface AudioCaptureEvents {
  chunk: (filePath: string) => void;
  ready: () => void;
  error: (error: Error) => void;
  stopped: () => void;
}

// ---------------------------------------------------------------------------
// Audio Capture Service
// ---------------------------------------------------------------------------

export class AudioCaptureService extends EventEmitter {
  private process: ChildProcess | null = null;
  private watcher: FSWatcher | null = null;
  private outputDir: string;
  private _isCapturing = false;
  private seenChunks = new Set<string>();

  constructor() {
    super();
    this.outputDir = '';
  }

  get isCapturing(): boolean {
    return this._isCapturing;
  }

  /**
   * Start audio capture.
   * @param options.app - Bundle ID to target (e.g., 'us.zoom.xos') or undefined for all system audio
   * @param options.outputDir - Directory for WAV chunks (auto-created if not set)
   * @param options.chunkSeconds - Chunk duration in seconds (default: 30)
   */
  async start(options: {
    app?: string;
    outputDir?: string;
    chunkSeconds?: number;
  } = {}): Promise<void> {
    if (this._isCapturing) {
      throw new Error('Audio capture is already running');
    }

    if (!ensureCaptureBinary()) {
      throw new Error('Audio capture binary not available. macOS 13+ and Xcode CLI tools required.');
    }

    this.outputDir = options.outputDir || join(tmpdir(), `ohwow-capture-${randomUUID()}`);
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }

    const args = ['--output-dir', this.outputDir];
    if (options.app) args.push('--app', options.app);
    if (options.chunkSeconds) args.push('--chunk-seconds', String(options.chunkSeconds));

    return new Promise((resolve, reject) => {
      this.process = spawn(BINARY_PATH, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let ready = false;

      this.process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          if (line === 'READY' && !ready) {
            ready = true;
            this._isCapturing = true;
            this.startWatching();
            this.emit('ready');
            resolve();
          } else if (line.startsWith('CHUNK:')) {
            const filename = line.slice(6);
            const filePath = join(this.outputDir, filename);
            if (!this.seenChunks.has(filename)) {
              this.seenChunks.add(filename);
              this.emit('chunk', filePath);
            }
          } else if (line === 'DONE') {
            // Clean shutdown complete
          }
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg.startsWith('Error:')) {
          if (!ready) {
            reject(new Error(msg));
          } else {
            this.emit('error', new Error(msg));
          }
        } else {
          logger.debug({ msg }, '[AudioCapture] stderr');
        }
      });

      this.process.on('exit', (code) => {
        this._isCapturing = false;
        this.stopWatching();
        if (!ready) {
          reject(new Error(`Capture process exited with code ${code} before becoming ready`));
        } else {
          this.emit('stopped');
        }
      });

      this.process.on('error', (err) => {
        this._isCapturing = false;
        if (!ready) {
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      // Timeout: if not ready in 10 seconds, reject
      setTimeout(() => {
        if (!ready) {
          this.kill();
          reject(new Error('Audio capture did not become ready within 10 seconds. Screen recording permission may be needed.'));
        }
      }, 10_000);
    });
  }

  /**
   * Stop audio capture gracefully.
   */
  async stop(): Promise<void> {
    if (!this.process || !this._isCapturing) return;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.kill();
        resolve();
      }, 5_000);

      this.process!.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      // Send SIGTERM for clean shutdown (flushes final chunk + writes DONE)
      this.process!.kill('SIGTERM');
    });
  }

  /**
   * Get the output directory where chunks are written.
   */
  getOutputDir(): string {
    return this.outputDir;
  }

  private kill(): void {
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
    this._isCapturing = false;
    this.stopWatching();
  }

  private startWatching(): void {
    this.stopWatching();
    try {
      this.watcher = watch(this.outputDir, (eventType, filename) => {
        if (!filename || !filename.endsWith('.wav')) return;
        if (this.seenChunks.has(filename)) return;
        // Debounce: file may still be writing. Check after a brief delay.
        setTimeout(() => {
          const filePath = join(this.outputDir, filename);
          if (existsSync(filePath) && !this.seenChunks.has(filename)) {
            this.seenChunks.add(filename);
            this.emit('chunk', filePath);
          }
        }, 200);
      });
    } catch (err) {
      logger.warn({ err }, '[AudioCapture] Failed to start file watcher, relying on stdout events');
    }
  }

  private stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
