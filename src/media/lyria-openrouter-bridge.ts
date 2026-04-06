/**
 * Lyria OpenRouter Bridge
 *
 * Routes music/audio generation requests to Google Lyria models via OpenRouter.
 * Lyria is Google's music generation model capable of producing high-quality
 * instrumental music, sound effects, and soundscapes from text prompts.
 *
 * Also supports video generation models available through OpenRouter.
 */

import { saveMediaBuffer, saveMediaFromUrl } from './storage.js';
import { logger } from '../lib/logger.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Lyria model IDs on OpenRouter */
export const LYRIA_MODELS = {
  /** Google Lyria — music generation */
  music: 'google/lyria',
  /** Google Veo 2 — video generation */
  video: 'google/veo-2',
} as const;

export interface LyriaConfig {
  apiKey: string;
}

export interface MusicGenerationParams {
  /** Text prompt describing the music to generate */
  prompt: string;
  /** Duration in seconds (5-30, default 15) */
  durationSeconds?: number;
  /** Genre hint (ambient, electronic, orchestral, jazz, rock, pop, lo-fi) */
  genre?: string;
  /** Mood hint (calm, energetic, dark, uplifting, melancholic, playful) */
  mood?: string;
  /** Tempo in BPM (60-180, optional) */
  bpm?: number;
}

export interface VideoGenerationParams {
  /** Text prompt describing the video to generate */
  prompt: string;
  /** Duration in seconds (2-10, default 4) */
  durationSeconds?: number;
  /** Aspect ratio (16:9, 9:16, 1:1) */
  aspectRatio?: string;
}

export class LyriaOpenRouterBridge {
  private apiKey: string;

  constructor(config: LyriaConfig) {
    this.apiKey = config.apiKey;
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ohwow.fun',
      'X-Title': 'OHWOW',
    };
  }

  /**
   * Check if the Lyria model is available on OpenRouter.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return false;
      const data = await resp.json() as { data?: Array<{ id: string }> };
      return data.data?.some(m => m.id === LYRIA_MODELS.music) ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Generate music from a text prompt via Google Lyria on OpenRouter.
   * Returns the saved audio file path.
   */
  async generateMusic(params: MusicGenerationParams): Promise<{ path: string; message: string }> {
    const {
      prompt,
      durationSeconds = 15,
      genre,
      mood,
      bpm,
    } = params;

    // Build an enriched prompt with musical context
    const parts = [prompt];
    if (genre) parts.push(`Genre: ${genre}`);
    if (mood) parts.push(`Mood: ${mood}`);
    if (bpm) parts.push(`Tempo: ${bpm} BPM`);
    parts.push(`Duration: approximately ${durationSeconds} seconds`);
    const fullPrompt = parts.join('. ');

    logger.info(`[lyria-bridge] Generating music: "${fullPrompt.slice(0, 100)}..."`);

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      signal: AbortSignal.timeout(180_000), // Music gen can take a while
      body: JSON.stringify({
        model: LYRIA_MODELS.music,
        messages: [
          {
            role: 'user',
            content: fullPrompt,
          },
        ],
        modalities: ['audio'],
        audio: {
          format: 'mp3',
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Lyria music generation failed (${response.status}): ${errText.slice(0, 300)}`);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          audio?: {
            data?: string;     // base64-encoded audio
            url?: string;      // or a URL to download
            format?: string;
          };
        };
      }>;
    };

    const audioData = data.choices?.[0]?.message?.audio;

    if (audioData?.data) {
      // Base64-encoded audio returned inline
      const buffer = Buffer.from(audioData.data, 'base64');
      const mimeType = audioData.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
      logger.info(`[lyria-bridge] Generated ${buffer.length} bytes of audio`);
      const saved = await saveMediaBuffer(buffer, mimeType, 'music');
      return {
        path: saved.path,
        message: `Music generated and saved to ${saved.path} (${Math.round(buffer.length / 1024)}KB)`,
      };
    }

    if (audioData?.url) {
      // Audio returned as a URL to download
      logger.info(`[lyria-bridge] Downloading audio from ${audioData.url}`);
      const mimeType = audioData.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
      const saved = await saveMediaFromUrl(audioData.url, mimeType, 'music');
      return {
        path: saved.path,
        message: `Music generated and saved to ${saved.path}`,
      };
    }

    // Fallback: check if the content itself is a URL or base64
    const content = data.choices?.[0]?.message?.content;
    if (content?.startsWith('http')) {
      const saved = await saveMediaFromUrl(content.trim(), 'audio/mpeg', 'music');
      return {
        path: saved.path,
        message: `Music generated and saved to ${saved.path}`,
      };
    }

    throw new Error('Lyria returned no audio data. The model may not support this request format yet.');
  }

  /**
   * Generate video from a text prompt via OpenRouter video models.
   * Returns the saved video file path.
   */
  async generateVideo(params: VideoGenerationParams): Promise<{ path: string; message: string }> {
    const {
      prompt,
      durationSeconds = 4,
      aspectRatio = '16:9',
    } = params;

    logger.info(`[lyria-bridge] Generating video: "${prompt.slice(0, 100)}..."`);

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      signal: AbortSignal.timeout(300_000), // Video gen takes longer
      body: JSON.stringify({
        model: LYRIA_MODELS.video,
        messages: [
          {
            role: 'user',
            content: `${prompt}. Duration: ${durationSeconds} seconds. Aspect ratio: ${aspectRatio}.`,
          },
        ],
        modalities: ['video'],
        video: {
          duration_seconds: durationSeconds,
          aspect_ratio: aspectRatio,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Video generation failed (${response.status}): ${errText.slice(0, 300)}`);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          video?: {
            data?: string;
            url?: string;
            format?: string;
          };
        };
      }>;
    };

    const videoData = data.choices?.[0]?.message?.video;

    if (videoData?.data) {
      const buffer = Buffer.from(videoData.data, 'base64');
      const mimeType = videoData.format === 'webm' ? 'video/webm' : 'video/mp4';
      logger.info(`[lyria-bridge] Generated ${buffer.length} bytes of video`);
      const saved = await saveMediaBuffer(buffer, mimeType, 'video');
      return {
        path: saved.path,
        message: `Video generated and saved to ${saved.path} (${Math.round(buffer.length / 1024)}KB)`,
      };
    }

    if (videoData?.url) {
      logger.info(`[lyria-bridge] Downloading video from ${videoData.url}`);
      const mimeType = videoData.format === 'webm' ? 'video/webm' : 'video/mp4';
      const saved = await saveMediaFromUrl(videoData.url, mimeType, 'video');
      return {
        path: saved.path,
        message: `Video generated and saved to ${saved.path}`,
      };
    }

    const content = data.choices?.[0]?.message?.content;
    if (content?.startsWith('http')) {
      const saved = await saveMediaFromUrl(content.trim(), 'video/mp4', 'video');
      return {
        path: saved.path,
        message: `Video generated and saved to ${saved.path}`,
      };
    }

    throw new Error('Video model returned no video data. The model may not support this request format yet.');
  }
}
