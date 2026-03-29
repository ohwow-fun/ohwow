/**
 * VibeVoice TTS Provider
 * Text-to-speech via Microsoft VibeVoice Realtime 0.5B model.
 * Lightweight streaming TTS with ~300ms first-audio latency.
 */

import type { TTSProvider, TTSResult, TTSOptions } from './types.js';

export class VibeVoiceTTSProvider implements TTSProvider {
  readonly name = 'vibevoice-realtime';
  readonly isLocal = true;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || process.env.VIBEVOICE_URL || 'http://localhost:8001').replace(/\/$/, '');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return false;
      const data = await resp.json() as { status: string; models?: { realtime?: boolean } };
      return data.status === 'ok' || data.status === 'healthy';
    } catch {
      return false;
    }
  }

  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const start = Date.now();

    const resp = await fetch(`${this.baseUrl}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: options?.voice,
        speed: options?.speed,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      throw new Error(`VibeVoice TTS failed: ${resp.status}`);
    }

    const arrayBuffer = await resp.arrayBuffer();

    return {
      audio: Buffer.from(arrayBuffer),
      durationMs: Date.now() - start,
    };
  }

  /** Synthesize a single sentence (used by chunked pipeline) */
  async synthesizeSentence(sentence: string): Promise<Buffer> {
    const result = await this.synthesize(sentence);
    return result.audio as Buffer;
  }
}
