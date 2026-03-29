/**
 * Text-to-Speech Providers
 * PiperProvider (local) and OpenAITTSProvider (cloud fallback).
 */

import type { TTSProvider, TTSResult, TTSOptions } from './types.js';

/**
 * Piper TTS provider for local speech synthesis.
 * Requires piper-tts binary installed locally.
 * https://github.com/rhasspy/piper
 */
export class PiperProvider implements TTSProvider {
  readonly name = 'piper-local';
  readonly isLocal = true;
  private piperPath: string;
  private modelPath: string;

  constructor(piperPath = 'piper', modelPath = '') {
    this.piperPath = piperPath;
    this.modelPath = modelPath;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      await exec(this.piperPath, ['--version']);
      return !!this.modelPath;
    } catch {
      return false;
    }
  }

  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const start = Date.now();

    const { spawn } = await import('node:child_process');

    const args = ['--model', this.modelPath, '--output_raw'];
    if (options?.speed) args.push('--length-scale', String(1 / options.speed));

    const stdout = await new Promise<Buffer>((resolve, reject) => {
      const proc = spawn(this.piperPath, args);
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on('data', () => { /* ignore stderr */ });
      proc.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`Piper exited with code ${code}`));
      });
      proc.on('error', reject);
      proc.stdin.write(text);
      proc.stdin.end();
    });

    return {
      audio: Buffer.from(stdout),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * OpenAI TTS API provider (cloud fallback).
 * Requires an OpenAI API key.
 */
export class OpenAITTSProvider implements TTSProvider {
  readonly name = 'openai-tts';
  readonly isLocal = false;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const start = Date.now();

    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: options?.voice || 'alloy',
        speed: options?.speed || 1.0,
        response_format: options?.format || 'mp3',
      }),
    });

    if (!resp.ok) {
      throw new Error(`OpenAI TTS API failed: ${resp.status}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      durationMs: Date.now() - start,
    };
  }
}
