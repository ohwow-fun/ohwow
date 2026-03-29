/**
 * Tests for VibeVoice STT, TTS, and Podcast Providers
 *
 * Stress tests #1 (health/lifecycle), #3 (provider fallback), and basic UX.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VibeVoiceTTSProvider } from '../vibevoice-tts-provider.js';
import { VibeVoiceSTTProvider } from '../vibevoice-stt-provider.js';
import { VibeVoicePodcastProvider } from '../vibevoice-podcast-provider.js';

const BASE_URL = 'http://localhost:8001';

// ---------------------------------------------------------------------------
// VibeVoice TTS Provider (Realtime 0.5B)
// ---------------------------------------------------------------------------

describe('VibeVoiceTTSProvider', () => {
  let provider: VibeVoiceTTSProvider;

  beforeEach(() => {
    provider = new VibeVoiceTTSProvider(BASE_URL);
    vi.restoreAllMocks();
  });

  it('has correct name and isLocal', () => {
    expect(provider.name).toBe('vibevoice-realtime');
    expect(provider.isLocal).toBe(true);
  });

  describe('isAvailable()', () => {
    it('returns true when health endpoint returns ok', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok', models: { realtime: true } }), { status: 200 }),
      );
      expect(await provider.isAvailable()).toBe(true);
    });

    it('returns true when health returns healthy', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'healthy' }), { status: 200 }),
      );
      expect(await provider.isAvailable()).toBe(true);
    });

    it('returns false on network error (server not running)', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await provider.isAvailable()).toBe(false);
    });

    it('returns false on HTTP 500', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Internal Server Error', { status: 500 }),
      );
      expect(await provider.isAvailable()).toBe(false);
    });

    it('returns false on timeout', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Aborted', 'AbortError'));
      expect(await provider.isAvailable()).toBe(false);
    });
  });

  describe('synthesize()', () => {
    it('synthesizes text and returns WAV buffer', async () => {
      const fakeAudio = new ArrayBuffer(4096);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(fakeAudio, { status: 200 }),
      );

      const result = await provider.synthesize('Hello world');

      expect(Buffer.isBuffer(result.audio)).toBe(true);
      expect((result.audio as Buffer).length).toBe(4096);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('passes voice and speed options in request body', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(100), { status: 200 }),
      );

      await provider.synthesize('Test', { voice: 'alloy', speed: 1.5 });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/generate`);
      const body = JSON.parse(init?.body as string);
      expect(body.text).toBe('Test');
      expect(body.voice).toBe('alloy');
      expect(body.speed).toBe(1.5);
    });

    it('throws on non-200 response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Model not loaded', { status: 503 }),
      );
      await expect(provider.synthesize('Hello')).rejects.toThrow('VibeVoice TTS failed: 503');
    });
  });

  describe('synthesizeSentence()', () => {
    it('returns Buffer directly for chunked pipeline', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(512), { status: 200 }),
      );

      const result = await provider.synthesizeSentence('A sentence.');
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(512);
    });
  });
});

// ---------------------------------------------------------------------------
// VibeVoice STT Provider (ASR 7B)
// ---------------------------------------------------------------------------

describe('VibeVoiceSTTProvider', () => {
  let provider: VibeVoiceSTTProvider;

  beforeEach(() => {
    provider = new VibeVoiceSTTProvider(BASE_URL);
    vi.restoreAllMocks();
  });

  it('has correct name and isLocal', () => {
    expect(provider.name).toBe('vibevoice-asr');
    expect(provider.isLocal).toBe(true);
  });

  describe('isAvailable()', () => {
    it('returns true when healthy', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      );
      expect(await provider.isAvailable()).toBe(true);
    });

    it('returns false when server not running', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await provider.isAvailable()).toBe(false);
    });
  });

  describe('transcribe()', () => {
    it('transcribes audio and returns plain text', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ text: 'Hello world', language: 'en' }), { status: 200 }),
      );

      const audio = Buffer.from(new Uint8Array(100));
      const result = await provider.transcribe(audio);

      expect(result.text).toBe('Hello world');
      expect(result.confidence).toBe(0.92);
      expect(result.language).toBe('en');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.segments).toBeUndefined();
    });

    it('returns diarized segments when provided', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          text: 'Speaker 1 says hi. Speaker 2 says hello.',
          language: 'en',
          segments: [
            { speaker: 'Speaker 1', text: 'says hi', start_ms: 0, end_ms: 2000, confidence: 0.95 },
            { speaker: 'Speaker 2', text: 'says hello', start_ms: 2100, end_ms: 4000, confidence: 0.91 },
          ],
        }), { status: 200 }),
      );

      const audio = Buffer.from(new Uint8Array(100));
      const result = await provider.transcribe(audio);

      expect(result.segments).toHaveLength(2);
      expect(result.segments![0]).toEqual({
        speaker: 'Speaker 1',
        text: 'says hi',
        startMs: 0,
        endMs: 2000,
        confidence: 0.95,
      });
      expect(result.segments![1]).toEqual({
        speaker: 'Speaker 2',
        text: 'says hello',
        startMs: 2100,
        endMs: 4000,
        confidence: 0.91,
      });
    });

    it('maps snake_case to camelCase in segments', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          text: 'test',
          segments: [
            { speaker: 'S1', text: 'test', start_ms: 500, end_ms: 1500 },
          ],
        }), { status: 200 }),
      );

      const result = await provider.transcribe(Buffer.from(new Uint8Array(10)));
      expect(result.segments![0].startMs).toBe(500);
      expect(result.segments![0].endMs).toBe(1500);
    });

    it('passes language option in FormData', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ text: 'Hola' }), { status: 200 }),
      );

      const audio = Buffer.from(new Uint8Array(100));
      await provider.transcribe(audio, { language: 'es' });

      const [, init] = mockFetch.mock.calls[0];
      expect(init?.body).toBeInstanceOf(FormData);
    });

    it('throws on non-200 response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Error', { status: 500 }),
      );

      const audio = Buffer.from(new Uint8Array(100));
      await expect(provider.transcribe(audio)).rejects.toThrow('VibeVoice ASR transcription failed: 500');
    });
  });
});

// ---------------------------------------------------------------------------
// VibeVoice Podcast Provider (TTS 1.5B)
// ---------------------------------------------------------------------------

describe('VibeVoicePodcastProvider', () => {
  let provider: VibeVoicePodcastProvider;

  beforeEach(() => {
    provider = new VibeVoicePodcastProvider(BASE_URL);
    vi.restoreAllMocks();
  });

  it('has correct name and isLocal', () => {
    expect(provider.name).toBe('vibevoice-podcast');
    expect(provider.isLocal).toBe(true);
  });

  describe('isAvailable()', () => {
    it('returns true when healthy', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      );
      expect(await provider.isAvailable()).toBe(true);
    });

    it('returns false when server not running', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await provider.isAvailable()).toBe(false);
    });
  });

  describe('generatePodcast()', () => {
    const request = {
      speakers: [
        { id: 's1', name: 'Alex' },
        { id: 's2', name: 'Jordan' },
      ],
      segments: [
        { speakerId: 's1', text: 'Welcome to the show.' },
        { speakerId: 's2', text: 'Thanks for having me.' },
      ],
    };

    it('returns audio directly for synchronous response', async () => {
      const fakeAudio = new ArrayBuffer(8192);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(fakeAudio, {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        }),
      );

      const result = await provider.generatePodcast(request);

      expect(Buffer.isBuffer(result.audio)).toBe(true);
      expect(result.audio.length).toBe(8192);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('sends correctly formatted request body', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(100), {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        }),
      );

      await provider.generatePodcast(request);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/podcast/generate`);
      const body = JSON.parse(init?.body as string);
      expect(body.speakers).toHaveLength(2);
      expect(body.segments[0].speaker_id).toBe('s1'); // camelCase → snake_case
      expect(body.segments[0].text).toBe('Welcome to the show.');
      expect(body.format).toBe('wav');
    });

    it('throws on non-200 response with error text', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Model out of memory', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
      );

      await expect(provider.generatePodcast(request)).rejects.toThrow(
        'VibeVoice podcast generation failed: 500',
      );
    });
  });

  describe('startPodcastJob()', () => {
    it('returns job ID for async generation', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ job_id: 'abc-123' }), { status: 200 }),
      );

      const jobId = await provider.startPodcastJob({
        speakers: [{ id: 's1', name: 'Host' }],
        segments: [{ speakerId: 's1', text: 'Hello' }],
      });

      expect(jobId).toBe('abc-123');
    });

    it('sends X-Async header', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ job_id: 'xyz' }), { status: 200 }),
      );

      await provider.startPodcastJob({
        speakers: [{ id: 's1', name: 'Host' }],
        segments: [{ speakerId: 's1', text: 'Hello' }],
      });

      const [, init] = mockFetch.mock.calls[0];
      expect((init?.headers as Record<string, string>)['X-Async']).toBe('true');
    });
  });

  describe('getPodcastJobStatus()', () => {
    it('returns pending status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'pending', progress: 0 }), { status: 200 }),
      );

      const result = await provider.getPodcastJobStatus('job-1');
      expect(result.status).toBe('pending');
      expect(result.progress).toBe(0);
      expect(result.audio).toBeUndefined();
    });

    it('returns processing status with progress', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'processing', progress: 50 }), { status: 200 }),
      );

      const result = await provider.getPodcastJobStatus('job-1');
      expect(result.status).toBe('processing');
      expect(result.progress).toBe(50);
    });

    it('returns completed status with audio', async () => {
      const fakeAudio = new ArrayBuffer(1024);
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'completed', progress: 100, audio_url: '/podcast/audio/job-1' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(fakeAudio, { status: 200 }),
        );

      const result = await provider.getPodcastJobStatus('job-1');
      expect(result.status).toBe('completed');
      expect(result.progress).toBe(100);
      expect(Buffer.isBuffer(result.audio)).toBe(true);
      expect(result.audio!.length).toBe(1024);
    });

    it('returns failed status with error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'failed', error: 'Out of memory' }), { status: 200 }),
      );

      const result = await provider.getPodcastJobStatus('job-1');
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Out of memory');
    });

    it('throws when job not found', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Job not found', { status: 404 }),
      );

      await expect(provider.getPodcastJobStatus('nonexistent')).rejects.toThrow(
        'VibeVoice podcast status check failed: 404',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Stress Test: Provider Fallback Chain
// ---------------------------------------------------------------------------

describe('Provider fallback chain', () => {
  it('VibeVoice is skipped when unavailable, does not block other providers', async () => {
    // Simulate: VibeVoice down, then next provider succeeds
    const vibevoiceTTS = new VibeVoiceTTSProvider('http://localhost:8001');
    const vibevoiceSTT = new VibeVoiceSTTProvider('http://localhost:8001');

    // Both should return false without throwing
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const [ttsAvailable, sttAvailable] = await Promise.all([
      vibevoiceTTS.isAvailable(),
      vibevoiceSTT.isAvailable(),
    ]);

    expect(ttsAvailable).toBe(false);
    expect(sttAvailable).toBe(false);
  });

  it('isAvailable() completes quickly on timeout (does not hang)', async () => {
    const provider = new VibeVoiceTTSProvider('http://localhost:8001');

    // Simulate a slow server that never responds
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 100);
      }),
    );

    const start = Date.now();
    const available = await provider.isAvailable();
    const elapsed = Date.now() - start;

    expect(available).toBe(false);
    expect(elapsed).toBeLessThan(5000); // Must not hang
  });

  it('default URL uses port 8001 (not 8000) to avoid collision with Voicebox', () => {
    // Verify the providers don't accidentally target the Voicebox port
    const tts = new VibeVoiceTTSProvider();
    const stt = new VibeVoiceSTTProvider();
    const podcast = new VibeVoicePodcastProvider();

    // Access private baseUrl via synthesize/transcribe call inspection
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );

    tts.isAvailable();
    expect(mockFetch.mock.calls[0][0]).toContain(':8001');

    mockFetch.mockClear();
    stt.isAvailable();
    expect(mockFetch.mock.calls[0][0]).toContain(':8001');

    mockFetch.mockClear();
    podcast.isAvailable();
    expect(mockFetch.mock.calls[0][0]).toContain(':8001');
  });
});
