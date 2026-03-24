/**
 * Voicebox STT Provider
 * Speech-to-text via Jamiepine's Voicebox (Whisper backend).
 */

import type { STTProvider, STTResult, STTOptions } from './types.js';

export class VoiceboxSTTProvider implements STTProvider {
  readonly name = 'voicebox-whisper';
  readonly isLocal = true;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || process.env.VOICEBOX_URL || 'http://localhost:8000').replace(/\/$/, '');
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

  async transcribe(audio: Buffer, options?: STTOptions): Promise<STTResult> {
    const start = Date.now();

    const formData = new FormData();
    const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    formData.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'audio.wav');
    if (options?.language) formData.append('language', options.language);

    const resp = await fetch(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`Voicebox transcription failed: ${resp.status}`);
    }

    const result = await resp.json() as { text: string; language?: string };

    return {
      text: result.text.trim(),
      confidence: 0.9,
      language: result.language || options?.language,
      durationMs: Date.now() - start,
    };
  }
}
