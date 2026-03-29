/**
 * VibeVoice STT Provider
 * Speech-to-text via Microsoft VibeVoice ASR 7B model.
 * Supports speaker diarization with structured Who/When/What output.
 */

import type { STTProvider, STTResult, STTOptions, TranscriptionSegment } from './types.js';

export class VibeVoiceSTTProvider implements STTProvider {
  readonly name = 'vibevoice-asr';
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
      signal: AbortSignal.timeout(120_000), // ASR 7B can be slow on large files
    });

    if (!resp.ok) {
      throw new Error(`VibeVoice ASR transcription failed: ${resp.status}`);
    }

    const result = await resp.json() as {
      text: string;
      language?: string;
      segments?: Array<{
        speaker: string;
        text: string;
        start_ms: number;
        end_ms: number;
        confidence?: number;
      }>;
    };

    // Map Python snake_case to TypeScript camelCase
    const segments: TranscriptionSegment[] | undefined = result.segments?.map((s) => ({
      speaker: s.speaker,
      text: s.text,
      startMs: s.start_ms,
      endMs: s.end_ms,
      confidence: s.confidence,
    }));

    return {
      text: result.text.trim(),
      confidence: 0.92,
      language: result.language || options?.language,
      durationMs: Date.now() - start,
      segments,
    };
  }
}
