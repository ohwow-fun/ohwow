/**
 * Voicebox TTS Provider
 * Text-to-speech via Jamiepine's Voicebox (Qwen3-TTS backend).
 * Supports voice cloning via profile IDs.
 */

import type { TTSProvider, TTSResult, TTSOptions } from './types.js';

export class VoiceboxTTSProvider implements TTSProvider {
  readonly name = 'voicebox-qwen3';
  readonly isLocal = true;
  private baseUrl: string;
  private defaultProfileId: string;

  constructor(baseUrl?: string, defaultProfileId = 'default') {
    this.baseUrl = (baseUrl || process.env.VOICEBOX_URL || 'http://localhost:8000').replace(/\/$/, '');
    this.defaultProfileId = defaultProfileId;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return false;
      const data = await resp.json() as { status: string };
      return data.status === 'ok' || data.status === 'healthy';
    } catch {
      return false;
    }
  }

  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const start = Date.now();
    const profileId = options?.voiceProfileId || this.defaultProfileId;

    const resp = await fetch(`${this.baseUrl}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        profile_id: profileId,
        language: 'en',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`Voicebox TTS failed: ${resp.status}`);
    }

    const arrayBuffer = await resp.arrayBuffer();

    return {
      audio: Buffer.from(arrayBuffer),
      durationMs: Date.now() - start,
    };
  }

  /** Synthesize a single sentence (used by chunked pipeline) */
  async synthesizeSentence(sentence: string, profileId?: string): Promise<Buffer> {
    const result = await this.synthesize(sentence, {
      voiceProfileId: profileId || this.defaultProfileId,
    });
    return result.audio as Buffer;
  }
}
