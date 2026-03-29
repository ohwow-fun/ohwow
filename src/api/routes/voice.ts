/**
 * Voice Routes
 * REST endpoints for voice profile management, provider status, and Voicebox control.
 *
 * GET  /api/voice/health         — Check Voicebox availability
 * GET  /api/voice/providers      — Check all STT/TTS provider availability
 * POST /api/voice/enable         — Start the Voicebox service
 * GET  /api/voice/profiles       — List voice profiles
 * POST /api/voice/profiles       — Create a voice profile
 * POST /api/voice/profiles/:id/samples — Upload a voice sample
 * POST /api/voice/test           — Test synthesis with a phrase
 */

import { Router } from 'express';
import { WhisperLocalProvider, WhisperAPIProvider } from '../../voice/stt-providers.js';
import { PiperProvider, OpenAITTSProvider } from '../../voice/tts-providers.js';
import { VoiceboxSTTProvider } from '../../voice/voicebox-stt-provider.js';
import { VoiceboxTTSProvider } from '../../voice/voicebox-tts-provider.js';
import { VibeVoiceSTTProvider } from '../../voice/vibevoice-stt-provider.js';
import { VibeVoiceTTSProvider } from '../../voice/vibevoice-tts-provider.js';
import type { VoiceboxService } from '../../voice/voicebox-service.js';

function getBaseUrl(): string {
  return (process.env.VOICEBOX_URL || 'http://localhost:8000').replace(/\/$/, '');
}

export function createVoiceRouter(voiceboxService?: VoiceboxService): Router {
  const router = Router();

  // Health check
  router.get('/api/voice/health', async (_req, res) => {
    try {
      const resp = await fetch(`${getBaseUrl()}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      res.json({ data });
    } catch (err) {
      res.json({
        data: {
          status: 'unavailable',
          model_loaded: false,
          error: err instanceof Error ? err.message : 'Voicebox not reachable',
        },
      });
    }
  });

  // Provider status — check all STT/TTS providers in parallel
  router.get('/api/voice/providers', async (_req, res) => {
    const baseUrl = getBaseUrl();
    const openaiKey = process.env.OPENAI_API_KEY || '';

    const vibevoiceUrl = (process.env.VIBEVOICE_URL || 'http://localhost:8001').replace(/\/$/, '');

    const sttProviders = [
      { instance: new VoiceboxSTTProvider(baseUrl), label: 'Voicebox (Whisper)' },
      { instance: new VibeVoiceSTTProvider(vibevoiceUrl), label: 'VibeVoice ASR (Local)' },
      { instance: new WhisperLocalProvider(), label: 'Whisper Local (Ollama)' },
      { instance: new WhisperAPIProvider(openaiKey), label: 'Whisper API (OpenAI)' },
    ];

    const ttsProviders = [
      { instance: new VoiceboxTTSProvider(baseUrl), label: 'Voicebox (TTS)' },
      { instance: new VibeVoiceTTSProvider(vibevoiceUrl), label: 'VibeVoice Realtime (Local)' },
      { instance: new PiperProvider(), label: 'Piper (Local)' },
      { instance: new OpenAITTSProvider(openaiKey), label: 'OpenAI TTS' },
    ];

    const [sttResults, ttsResults] = await Promise.all([
      Promise.allSettled(sttProviders.map(async (p) => ({
        name: p.instance.name,
        label: p.label,
        available: await p.instance.isAvailable(),
      }))),
      Promise.allSettled(ttsProviders.map(async (p) => ({
        name: p.instance.name,
        label: p.label,
        available: await p.instance.isAvailable(),
      }))),
    ]);

    const stt = sttResults.map((r) =>
      r.status === 'fulfilled' ? r.value : { name: 'unknown', label: 'Unknown', available: false }
    );
    const tts = ttsResults.map((r) =>
      r.status === 'fulfilled' ? r.value : { name: 'unknown', label: 'Unknown', available: false }
    );

    const anySttAvailable = stt.some((p) => p.available);
    const anyTtsAvailable = tts.some((p) => p.available);
    const voiceboxAvailable = stt.some((p) => p.name === 'voicebox-whisper' && p.available);

    res.json({
      data: {
        stt,
        tts,
        anyAvailable: anySttAvailable && anyTtsAvailable,
        voiceboxAvailable,
      },
    });
  });

  // Start Voicebox service on demand
  router.post('/api/voice/enable', async (_req, res) => {
    if (!voiceboxService) {
      res.status(503).json({ error: 'Voicebox service not configured' });
      return;
    }

    try {
      await voiceboxService.ensureRunning();
      res.json({ data: { status: 'running' } });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Could not start Voicebox',
      });
    }
  });

  // List profiles
  router.get('/api/voice/profiles', async (_req, res) => {
    try {
      const resp = await fetch(`${getBaseUrl()}/profiles`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        res.status(502).json({ error: `Voicebox returned ${resp.status}` });
        return;
      }
      const data = await resp.json();
      const profiles = Array.isArray(data) ? data : (data as { profiles: unknown[] }).profiles || [];
      res.json({ data: profiles });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Voicebox error' });
    }
  });

  // Create profile
  router.post('/api/voice/profiles', async (req, res) => {
    try {
      const { name, language } = req.body as { name?: string; language?: string };
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const resp = await fetch(`${getBaseUrl()}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, language: language || 'en' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        res.status(502).json({ error: `Voicebox returned ${resp.status}` });
        return;
      }
      const profile = await resp.json();
      res.status(201).json({ data: profile });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Voicebox error' });
    }
  });

  // Upload voice sample
  router.post('/api/voice/profiles/:id/samples', async (req, res) => {
    try {
      const profileId = req.params.id;
      const transcript = (req.query.transcript as string) || '';

      // Collect raw body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const audioBuffer = Buffer.concat(chunks);

      if (audioBuffer.length === 0) {
        res.status(400).json({ error: 'Audio data is required' });
        return;
      }

      const formData = new FormData();
      formData.append(
        'file',
        new Blob([new Uint8Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength)], { type: 'audio/wav' }),
        'sample.wav'
      );
      formData.append('transcript', transcript);

      const resp = await fetch(`${getBaseUrl()}/profiles/${profileId}/samples`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        res.status(502).json({ error: `Voicebox returned ${resp.status}` });
        return;
      }
      res.json({ data: { success: true } });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Voicebox error' });
    }
  });

  // Test synthesis
  router.post('/api/voice/test', async (req, res) => {
    try {
      const { text, profileId } = req.body as { text?: string; profileId?: string };
      if (!text || !profileId) {
        res.status(400).json({ error: 'text and profileId are required' });
        return;
      }

      const resp = await fetch(`${getBaseUrl()}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, profile_id: profileId, language: 'en' }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        res.status(502).json({ error: `Voicebox returned ${resp.status}` });
        return;
      }

      const audioBuffer = await resp.arrayBuffer();
      res.set('Content-Type', 'audio/wav');
      res.send(Buffer.from(audioBuffer));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Voicebox error' });
    }
  });

  return router;
}
