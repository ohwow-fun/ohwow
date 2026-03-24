/**
 * Kokoro TTS MCP Bridge
 *
 * Wraps Kokoro-FastAPI (http://localhost:8880) for local text-to-speech.
 * Kokoro is an 82M parameter TTS model that runs on CPU alone,
 * leaving all VRAM available for image/video generation.
 */

import { saveMediaBuffer } from './storage.js';
import { logger } from '../lib/logger.js';

const DEFAULT_URL = 'http://127.0.0.1:8880';

export interface KokoroBridgeConfig {
  url?: string;
}

export class KokoroBridge {
  private baseUrl: string;

  constructor(config?: KokoroBridgeConfig) {
    this.baseUrl = (config?.url ?? DEFAULT_URL).replace(/\/$/, '');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/v1/audio/voices`, {
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available voices.
   */
  async listVoices(): Promise<string[]> {
    try {
      const resp = await fetch(`${this.baseUrl}/v1/audio/voices`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [];
      const data = await resp.json() as { voices?: Array<{ name: string }> };
      return data.voices?.map(v => v.name) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Convert text to speech and save the audio file.
   */
  async textToSpeech(params: {
    text: string;
    voice?: string;
    speed?: number;
  }): Promise<{ path: string; message: string }> {
    const { text, voice, speed = 1.0 } = params;

    // Use OpenAI-compatible TTS endpoint
    const resp = await fetch(`${this.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kokoro',
        input: text,
        voice: voice ?? 'af_heart',
        speed,
        response_format: 'mp3',
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Kokoro TTS failed (${resp.status}): ${errText}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    logger.info(`[kokoro-bridge] Generated ${buffer.length} bytes of audio`);

    const saved = await saveMediaBuffer(buffer, 'audio/mpeg', 'tts');
    return {
      path: saved.path,
      message: `Audio generated and saved to ${saved.path}`,
    };
  }
}
