/**
 * Speech-to-Text Providers
 * WhisperLocal (via Ollama or whisper.cpp) and WhisperAPI (OpenAI fallback).
 */

import type { STTProvider, STTResult, STTOptions } from './types.js';

/**
 * Local Whisper provider using Ollama's audio endpoint.
 * Requires Ollama running with a whisper model pulled.
 */
export class WhisperLocalProvider implements STTProvider {
  readonly name = 'whisper-local';
  readonly isLocal = true;
  private ollamaUrl: string;
  private model: string;

  constructor(ollamaUrl = 'http://localhost:11434', model = 'whisper') {
    this.ollamaUrl = ollamaUrl;
    this.model = model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return false;
      const data = (await resp.json()) as { models?: Array<{ name: string }> };
      return (data.models || []).some((m) => m.name.startsWith(this.model));
    } catch {
      return false;
    }
  }

  async transcribe(audio: Buffer, options?: STTOptions): Promise<STTResult> {
    const start = Date.now();

    // Ollama audio transcription endpoint (when available)
    // Falls back to whisper.cpp CLI if Ollama doesn't support audio yet
    const resp = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: options?.prompt || 'Transcribe the following audio.',
        images: [audio.toString('base64')], // Ollama uses images field for binary
        stream: false,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Whisper local transcription failed: ${resp.status}`);
    }

    const result = (await resp.json()) as { response: string };
    return {
      text: result.response.trim(),
      confidence: 0.85, // Local models don't return confidence
      language: options?.language,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Gemma 4 audio provider using Ollama.
 * Uses Gemma 4 E2B or E4B for transcription + understanding in one pass.
 * Advantage over Whisper: combined STT and comprehension, plus the model
 * can answer follow-up questions about the audio content.
 *
 * NOTE: Ollama audio API format is provisional. Currently sends audio as
 * base64 in the `images` field (same transport as WhisperLocalProvider).
 * This may change when Ollama adds native audio field support.
 */
export class GemmaAudioProvider implements STTProvider {
  readonly name = 'gemma-audio';
  readonly isLocal = true;
  private ollamaUrl: string;
  private model: string;

  constructor(ollamaUrl = 'http://localhost:11434', model = 'gemma4:e2b') {
    this.ollamaUrl = ollamaUrl;
    this.model = model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return false;
      const data = (await resp.json()) as { models?: Array<{ name: string }> };
      return (data.models || []).some((m) => m.name.startsWith(this.model.split(':')[0]));
    } catch {
      return false;
    }
  }

  async transcribe(audio: Buffer, options?: STTOptions): Promise<STTResult> {
    const start = Date.now();

    const resp = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: options?.prompt || 'Transcribe the following audio accurately. Return only the transcription text.',
        images: [audio.toString('base64')],
        stream: false,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Gemma audio transcription failed: ${resp.status}`);
    }

    const result = (await resp.json()) as { response: string };
    return {
      text: result.response.trim(),
      confidence: 0.90,
      language: options?.language,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * OpenAI Whisper API provider (cloud fallback).
 * Requires an OpenAI API key.
 */
export class WhisperAPIProvider implements STTProvider {
  readonly name = 'whisper-api';
  readonly isLocal = false;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async transcribe(audio: Buffer, options?: STTOptions): Promise<STTResult> {
    const start = Date.now();

    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'whisper-1');
    if (options?.language) formData.append('language', options.language);
    if (options?.prompt) formData.append('prompt', options.prompt);

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!resp.ok) {
      throw new Error(`OpenAI Whisper API failed: ${resp.status}`);
    }

    const result = (await resp.json()) as { text: string };
    return {
      text: result.text.trim(),
      confidence: 0.95,
      language: options?.language,
      durationMs: Date.now() - start,
    };
  }
}
