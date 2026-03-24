/**
 * Whisper STT MCP Bridge
 *
 * Wraps local Whisper (whisper.cpp or faster-whisper) for speech-to-text
 * transcription. Runs entirely on the local machine.
 */

import { logger } from '../lib/logger.js';

export interface WhisperBridgeConfig {
  /** Path to the whisper binary. Auto-detected if not specified. */
  binaryPath?: string;
  /** Whisper model size: tiny, base, small, medium, large. */
  modelSize?: string;
}

export class WhisperBridge {
  private binaryPath: string | null = null;
  private modelSize: string;

  constructor(config?: WhisperBridgeConfig) {
    this.binaryPath = config?.binaryPath ?? null;
    this.modelSize = config?.modelSize ?? 'base';
  }

  async isAvailable(): Promise<boolean> {
    const binary = await this.findBinary();
    return binary !== null;
  }

  private async findBinary(): Promise<string | null> {
    if (this.binaryPath) return this.binaryPath;

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // Try common whisper binaries
    for (const name of ['whisper', 'faster-whisper', 'whisper-cpp']) {
      try {
        const { stdout } = await execFileAsync('which', [name], { timeout: 2000 });
        const path = stdout.trim();
        if (path) {
          this.binaryPath = path;
          return path;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Transcribe an audio file to text.
   */
  async transcribe(params: {
    file_path: string;
    language?: string;
  }): Promise<{ text: string; message: string }> {
    const binary = await this.findBinary();
    if (!binary) {
      throw new Error('Whisper not found. Install whisper, faster-whisper, or whisper.cpp.');
    }

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const args = [params.file_path, '--model', this.modelSize, '--output_format', 'txt'];
    if (params.language) {
      args.push('--language', params.language);
    }

    logger.info(`[whisper-bridge] Transcribing ${params.file_path} with model ${this.modelSize}`);

    try {
      const { stdout } = await execFileAsync(binary, args, {
        timeout: 300_000, // 5 minute timeout
      });

      const text = stdout.trim();
      return {
        text,
        message: `Transcription complete (${text.split(/\s+/).length} words)`,
      };
    } catch (err) {
      throw new Error(`Whisper transcription failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
