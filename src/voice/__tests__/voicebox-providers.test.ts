/**
 * Tests for Voicebox STT and TTS Providers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VoiceboxSTTProvider } from '../voicebox-stt-provider.js';
import { VoiceboxTTSProvider } from '../voicebox-tts-provider.js';

const BASE_URL = 'http://localhost:8000';

describe('VoiceboxSTTProvider', () => {
  let provider: VoiceboxSTTProvider;

  beforeEach(() => {
    provider = new VoiceboxSTTProvider(BASE_URL);
    vi.restoreAllMocks();
  });

  it('has correct name and isLocal', () => {
    expect(provider.name).toBe('voicebox-whisper');
    expect(provider.isLocal).toBe(true);
  });

  describe('isAvailable()', () => {
    it('returns true when health endpoint returns ok', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      );
      expect(await provider.isAvailable()).toBe(true);
    });

    it('returns false on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await provider.isAvailable()).toBe(false);
    });
  });

  describe('transcribe()', () => {
    it('transcribes audio buffer', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ text: 'Hello world', language: 'en' }), { status: 200 }),
      );

      const audio = Buffer.from(new Uint8Array(100));
      const result = await provider.transcribe(audio);

      expect(result.text).toBe('Hello world');
      expect(result.confidence).toBe(0.9);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('passes language option', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ text: 'Hola' }), { status: 200 }),
      );

      const audio = Buffer.from(new Uint8Array(100));
      await provider.transcribe(audio, { language: 'es' });

      // Check that language was passed in FormData
      const [, init] = mockFetch.mock.calls[0];
      expect(init?.body).toBeInstanceOf(FormData);
    });

    it('throws on non-200 response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Error', { status: 500 }),
      );

      const audio = Buffer.from(new Uint8Array(100));
      await expect(provider.transcribe(audio)).rejects.toThrow('Voicebox transcription failed: 500');
    });

    it('returns confidence of exactly 0.9', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ text: 'test' }), { status: 200 }),
      );
      const result = await provider.transcribe(Buffer.from(new Uint8Array(10)));
      expect(result.confidence).toBe(0.9);
    });
  });
});

describe('VoiceboxTTSProvider', () => {
  let provider: VoiceboxTTSProvider;

  beforeEach(() => {
    provider = new VoiceboxTTSProvider(BASE_URL, 'test-profile');
    vi.restoreAllMocks();
  });

  it('has correct name and isLocal', () => {
    expect(provider.name).toBe('voicebox-qwen3');
    expect(provider.isLocal).toBe(true);
  });

  describe('synthesize()', () => {
    it('synthesizes text to audio buffer', async () => {
      const fakeAudio = new ArrayBuffer(2048);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(fakeAudio, { status: 200 }),
      );

      const result = await provider.synthesize('Hello world');

      expect(Buffer.isBuffer(result.audio)).toBe(true);
      expect((result.audio as Buffer).length).toBe(2048);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('uses voiceProfileId from options', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(100), { status: 200 }),
      );

      await provider.synthesize('Test', { voiceProfileId: 'custom-profile' });

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body.profile_id).toBe('custom-profile');
    });

    it('falls back to default profile', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(100), { status: 200 }),
      );

      await provider.synthesize('Test');

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body.profile_id).toBe('test-profile');
    });

    it('throws on non-200 response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Server Error', { status: 500 }),
      );
      await expect(provider.synthesize('Hello')).rejects.toThrow();
    });
  });

  describe('synthesizeSentence()', () => {
    it('returns Buffer directly', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(512), { status: 200 }),
      );

      const result = await provider.synthesizeSentence('A sentence.');
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(512);
    });
  });
});
