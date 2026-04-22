/**
 * fal.ai video-clip adapter.
 *
 * Uses fal.ai's queue-based HTTP API directly (no @fal-ai/client dep) so
 * this file stays dependency-free. Works with any fal.ai text-to-video
 * model — Luma Dream Machine, Kling 2.1, Hailuo, etc. The model id is
 * read from FAL_VIDEO_MODEL.
 *
 * Credential resolution (first match wins):
 *   1. process.env.FAL_KEY / FAL_VIDEO_MODEL
 *   2. ~/.ohwow/config.json { falKey, falVideoModel }
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOrCreate } from '../asset-cache.js';
import { logger } from '../../lib/logger.js';
import type { VideoClipProvider, VideoProviderMeta } from '../video-clip-provider.js';
import { composeSeedancePrompt } from '../video-clip-provider.js';

const DEFAULT_MODEL = 'fal-ai/luma-dream-machine';

function loadFalCreds(): { apiKey: string; model: string } {
  const envKey = process.env.FAL_KEY?.trim();
  const envModel = process.env.FAL_VIDEO_MODEL?.trim();
  if (envKey) return { apiKey: envKey, model: envModel || DEFAULT_MODEL };
  try {
    const raw = readFileSync(join(homedir(), '.ohwow', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { falKey?: string; falVideoModel?: string };
    const fileKey = parsed.falKey?.trim();
    if (fileKey) return { apiKey: fileKey, model: envModel || parsed.falVideoModel?.trim() || DEFAULT_MODEL };
  } catch {
    // No config file, no key. Caller will surface "unavailable".
  }
  return { apiKey: '', model: envModel || DEFAULT_MODEL };
}
const QUEUE_POLL_MS = 2_000;
const MAX_POLLS = 150; // 5 minutes at 2s interval

interface FalQueueResponse {
  status?: string;
  response_url?: string;
  status_url?: string;
}

interface FalResultResponse {
  video?: { url?: string };
  data?: { video?: { url?: string } };
}

async function pollUntilComplete(statusUrl: string, apiKey: string): Promise<string> {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, QUEUE_POLL_MS));
    const resp = await fetch(statusUrl, {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) continue;
    const data = (await resp.json()) as FalQueueResponse;
    if (data.status === 'COMPLETED' && data.response_url) return data.response_url;
    if (data.status === 'FAILED') {
      throw new Error(`fal.ai job failed: ${JSON.stringify(data).slice(0, 200)}`);
    }
  }
  throw new Error('fal.ai job timed out after 5 minutes');
}

const FAL_META: VideoProviderMeta = {
  id: 'fal',
  name: 'fal.ai (Luma Dream Machine)',
  creditTier: 'premium',
  quality: 'high',
  speed: 'medium',
  maxDuration: 5,
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  capabilities: ['text-to-video', 'image-to-video'],
  priority: 20,
};

export const falProvider: VideoClipProvider = {
  name: 'fal',
  meta: FAL_META,
  priority: 20,
  async isAvailable() {
    return Boolean(loadFalCreds().apiKey);
  },
  estimateCostCents(req) {
    // Luma: ~$0.35/sec. Kling: ~$0.40/sec. Hailuo: ~$0.28/sec.
    // Default mid-tier estimate is fine for routing; the router treats
    // this as an upper bound.
    return Math.ceil(35 * req.durationSeconds);
  },
  async generate(req) {
    const { apiKey, model } = loadFalCreds();
    if (!apiKey) throw new Error('fal adapter unavailable (set FAL_KEY or ~/.ohwow/config.json falKey)');

    const started = Date.now();
    const entry = await getOrCreate(
      'video',
      {
        provider: 'fal',
        model,
        prompt: req.prompt,
        durationSeconds: req.durationSeconds,
        aspectRatio: req.aspectRatio,
        seed: req.seed ?? 0,
      },
      {
        produce: async () => {
          const effectivePrompt = req.seedancePrompt && model.includes('seedance')
            ? composeSeedancePrompt(req.seedancePrompt)
            : req.prompt;
          logger.info(`[video-clip/fal] submitting to ${model} (${req.durationSeconds}s ${req.aspectRatio})`);
          const submitResp = await fetch(`https://queue.fal.run/${model}`, {
            method: 'POST',
            headers: {
              Authorization: `Key ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              prompt: effectivePrompt,
              aspect_ratio: req.aspectRatio,
              // Seedance/Kling/Hailuo expect bare-number strings; Luma wants "5s".
              // Bare number works across the modern catalog; Luma is the only holdout.
              duration: model.includes('luma') ? `${req.durationSeconds}s` : String(req.durationSeconds),
              seed: req.seed ?? 0,
              // Seedance accepts 480p/720p/1080p. Other models ignore unknown keys.
              resolution: '720p',
              ...(req.referenceImageUrl ? { image_url: req.referenceImageUrl } : {}),
              ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
            }),
            signal: AbortSignal.timeout(60_000),
          });

          if (!submitResp.ok) {
            const errText = await submitResp.text().catch(() => '');
            throw new Error(`fal.ai submit failed (${submitResp.status}): ${errText.slice(0, 200)}`);
          }

          const submit = (await submitResp.json()) as FalQueueResponse;
          if (!submit.status_url) {
            throw new Error(`fal.ai submit response missing status_url: ${JSON.stringify(submit).slice(0, 200)}`);
          }

          const responseUrl = await pollUntilComplete(submit.status_url, apiKey);
          const resultResp = await fetch(responseUrl, {
            headers: { Authorization: `Key ${apiKey}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (!resultResp.ok) {
            throw new Error(`fal.ai result fetch failed: ${resultResp.status}`);
          }

          const result = (await resultResp.json()) as FalResultResponse;
          const videoUrl = result.video?.url ?? result.data?.video?.url;
          if (!videoUrl) {
            throw new Error(`fal.ai result missing video.url: ${JSON.stringify(result).slice(0, 200)}`);
          }

          const download = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
          if (!download.ok) throw new Error(`Couldn't download fal.ai clip: HTTP ${download.status}`);
          const buffer = Buffer.from(await download.arrayBuffer());
          if (buffer.byteLength === 0) throw new Error('fal.ai returned empty clip');
          return { buffer, extension: '.mp4' };
        },
      },
    );

    return {
      ...entry,
      providerName: 'fal',
      generationMs: entry.cached ? 0 : Date.now() - started,
    };
  },
};
