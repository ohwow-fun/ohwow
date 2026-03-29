/**
 * VibeVoice Podcast Provider
 * Multi-speaker podcast generation via Microsoft VibeVoice TTS 1.5B.
 * Supports up to 4 speakers, 90 minutes of conversational audio.
 */

import type { PodcastRequest, PodcastResult } from './types.js';

export class VibeVoicePodcastProvider {
  readonly name = 'vibevoice-podcast';
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

  /** Generate podcast audio directly (for short scripts). */
  async generatePodcast(request: PodcastRequest): Promise<PodcastResult> {
    const start = Date.now();

    const resp = await fetch(`${this.baseUrl}/podcast/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        speakers: request.speakers,
        segments: request.segments.map((s) => ({
          speaker_id: s.speakerId,
          text: s.text,
        })),
        format: request.format || 'wav',
      }),
      signal: AbortSignal.timeout(600_000), // 10 minutes for long podcasts
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`VibeVoice podcast generation failed: ${resp.status} — ${errorText}`);
    }

    // Check if we got a job_id (async) or direct audio
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json() as { job_id: string };
      return this.pollPodcastJob(data.job_id, start);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      durationMs: Date.now() - start,
      segments: [],
    };
  }

  /** Start a podcast generation job (returns job ID for polling). */
  async startPodcastJob(request: PodcastRequest): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/podcast/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Async': 'true',
      },
      body: JSON.stringify({
        speakers: request.speakers,
        segments: request.segments.map((s) => ({
          speaker_id: s.speakerId,
          text: s.text,
        })),
        format: request.format || 'wav',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`VibeVoice podcast job start failed: ${resp.status}`);
    }

    const data = await resp.json() as { job_id: string };
    return data.job_id;
  }

  /** Poll a podcast generation job for completion. */
  async getPodcastJobStatus(jobId: string): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress?: number;
    audio?: Buffer;
    error?: string;
  }> {
    const resp = await fetch(`${this.baseUrl}/podcast/status/${jobId}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      throw new Error(`VibeVoice podcast status check failed: ${resp.status}`);
    }

    const data = await resp.json() as {
      status: 'pending' | 'processing' | 'completed' | 'failed';
      progress?: number;
      audio_url?: string;
      error?: string;
    };

    if (data.status === 'completed' && data.audio_url) {
      const audioResp = await fetch(`${this.baseUrl}${data.audio_url}`, {
        signal: AbortSignal.timeout(60_000),
      });
      const arrayBuffer = await audioResp.arrayBuffer();
      return {
        status: 'completed',
        progress: 100,
        audio: Buffer.from(arrayBuffer),
      };
    }

    return {
      status: data.status,
      progress: data.progress,
      error: data.error,
    };
  }

  /** Poll until a job completes or fails. */
  private async pollPodcastJob(jobId: string, startTime: number): Promise<PodcastResult> {
    const maxWaitMs = 600_000; // 10 minutes
    const pollInterval = 2000;

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.getPodcastJobStatus(jobId);
      if (result.status === 'completed' && result.audio) {
        return {
          audio: result.audio,
          durationMs: Date.now() - startTime,
          segments: [],
        };
      }
      if (result.status === 'failed') {
        throw new Error(`Podcast generation failed: ${result.error || 'unknown error'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error('Podcast generation timed out');
  }
}
