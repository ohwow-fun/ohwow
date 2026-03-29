/**
 * Podcast Routes
 * REST endpoints for multi-speaker podcast generation via VibeVoice TTS 1.5B.
 *
 * POST /api/podcast/generate       — Start podcast generation
 * GET  /api/podcast/status/:jobId  — Poll job status
 * GET  /api/podcast/models         — Check model availability
 * POST /api/podcast/models/download — Trigger model download
 */

import { Router } from 'express';
import { VibeVoicePodcastProvider } from '../../voice/vibevoice-podcast-provider.js';
import type { VibeVoiceService } from '../../voice/vibevoice-service.js';
import type { PodcastRequest } from '../../voice/types.js';

function getBaseUrl(): string {
  return (process.env.VIBEVOICE_URL || 'http://localhost:8001').replace(/\/$/, '');
}

export function createPodcastRouter(vibeVoiceService?: VibeVoiceService): Router {
  const router = Router();

  // Generate podcast
  router.post('/api/podcast/generate', async (req, res) => {
    const baseUrl = getBaseUrl();
    const provider = new VibeVoicePodcastProvider(baseUrl);

    if (!await provider.isAvailable()) {
      res.status(503).json({ error: 'VibeVoice server is not running. Start it first via POST /api/voice/enable-vibevoice' });
      return;
    }

    try {
      const body = req.body as PodcastRequest;

      if (!body.speakers?.length || !body.segments?.length) {
        res.status(400).json({ error: 'speakers and segments are required' });
        return;
      }

      if (body.speakers.length > 4) {
        res.status(400).json({ error: 'VibeVoice supports up to 4 speakers' });
        return;
      }

      // For short scripts, generate directly
      const totalTextLength = body.segments.reduce((sum, s) => sum + s.text.length, 0);

      if (totalTextLength <= 500) {
        const result = await provider.generatePodcast(body);
        res.set('Content-Type', 'audio/wav');
        res.send(result.audio);
      } else {
        // Long scripts: start async job
        const jobId = await provider.startPodcastJob(body);
        res.status(202).json({ data: { jobId, status: 'pending' } });
      }
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Podcast generation failed',
      });
    }
  });

  // Poll job status
  router.get('/api/podcast/status/:jobId', async (req, res) => {
    const baseUrl = getBaseUrl();
    const provider = new VibeVoicePodcastProvider(baseUrl);

    try {
      const result = await provider.getPodcastJobStatus(req.params.jobId);

      if (result.status === 'completed' && result.audio) {
        res.set('Content-Type', 'audio/wav');
        res.send(result.audio);
      } else {
        res.json({ data: result });
      }
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Status check failed',
      });
    }
  });

  // Check model availability
  router.get('/api/podcast/models', async (_req, res) => {
    const baseUrl = getBaseUrl();

    try {
      const resp = await fetch(`${baseUrl}/models/status`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        res.json({ data: { available: false, error: 'VibeVoice server not reachable' } });
        return;
      }
      const data = await resp.json() as Record<string, unknown>;
      res.json({ data: { available: true, models: data } });
    } catch {
      res.json({ data: { available: false, error: 'VibeVoice server not reachable' } });
    }
  });

  // Trigger model download
  router.post('/api/podcast/models/download', async (req, res) => {
    const baseUrl = getBaseUrl();
    const { model } = req.body as { model?: string };

    try {
      const resp = await fetch(`${baseUrl}/models/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'tts' }),
        signal: AbortSignal.timeout(600_000), // 10 minutes for large downloads
      });

      if (!resp.ok) {
        const text = await resp.text();
        res.status(502).json({ error: text });
        return;
      }

      const data = await resp.json();
      res.json({ data });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Model download failed',
      });
    }
  });

  // Start VibeVoice service on demand
  router.post('/api/voice/enable-vibevoice', async (_req, res) => {
    if (!vibeVoiceService) {
      res.status(503).json({ error: 'VibeVoice service not configured' });
      return;
    }

    try {
      await vibeVoiceService.ensureRunning();
      res.json({ data: { status: 'running' } });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Could not start VibeVoice',
      });
    }
  });

  return router;
}
