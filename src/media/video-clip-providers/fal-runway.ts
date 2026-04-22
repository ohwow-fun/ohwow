/**
 * fal.ai Runway Gen-3 Turbo image-to-video adapter.
 *
 * Runway is a premium image-to-video provider. Pass `referenceImageUrl`
 * in the request for the source frame; `prompt` drives the motion.
 *
 * Env:
 *   FAL_KEY   fal.ai API key (required)
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOrCreate } from '../asset-cache.js';
import { logger } from '../../lib/logger.js';
import type { VideoClipProvider, VideoProviderMeta } from '../video-clip-provider.js';

// NOTE: fal-ai/runway-gen3/turbo/image-to-video may return 404 if Runway
// removes it. Monitor and update to gen4 when fal.ai publishes the endpoint.
const MODEL = 'fal-ai/runway-gen3/turbo/image-to-video';

function loadApiKey(): string {
  const envKey = process.env.FAL_KEY?.trim();
  if (envKey) return envKey;
  try {
    const raw = readFileSync(join(homedir(), '.ohwow', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { falKey?: string };
    return parsed.falKey?.trim() ?? '';
  } catch {
    return '';
  }
}

const QUEUE_POLL_MS = 2_000;
const MAX_POLLS = 150;

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
      throw new Error(`fal.ai/runway job failed: ${JSON.stringify(data).slice(0, 200)}`);
    }
  }
  throw new Error('fal.ai/runway job timed out after 5 minutes');
}

const RUNWAY_META: VideoProviderMeta = {
  id: 'fal-runway',
  name: 'Runway Gen-3 Turbo (fal.ai)',
  creditTier: 'premium',
  quality: 'ultra',
  speed: 'fast',
  maxDuration: 10,
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  capabilities: ['image-to-video'],
  priority: 28,
};

export const falRunwayProvider: VideoClipProvider = {
  name: 'fal-runway',
  meta: RUNWAY_META,
  priority: 28,
  async isAvailable() {
    return Boolean(loadApiKey());
  },
  estimateCostCents(req) {
    // Runway Gen-3 Turbo: ~$0.55/sec (premium motion control)
    return Math.ceil(55 * req.durationSeconds);
  },
  async generate(req) {
    const apiKey = loadApiKey();
    if (!apiKey) throw new Error('fal-runway adapter unavailable (set FAL_KEY or ~/.ohwow/config.json falKey)');

    const started = Date.now();
    const entry = await getOrCreate(
      'video',
      {
        provider: 'fal-runway',
        model: MODEL,
        prompt: req.prompt,
        durationSeconds: req.durationSeconds,
        aspectRatio: req.aspectRatio,
        seed: req.seed ?? 0,
        referenceImageUrl: req.referenceImageUrl,
      },
      {
        produce: async () => {
          logger.info(`[video-clip/fal-runway] submitting (${req.durationSeconds}s ${req.aspectRatio})`);
          const body: Record<string, unknown> = {
            prompt: req.prompt || 'Subtle, natural motion',
            duration: String(req.durationSeconds) as '5' | '10',
          };
          if (req.referenceImageUrl) body.image_url = req.referenceImageUrl;
          if (req.negativePrompt) body.negative_prompt = req.negativePrompt;

          const submitResp = await fetch(`https://queue.fal.run/${MODEL}`, {
            method: 'POST',
            headers: {
              Authorization: `Key ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
          });

          if (!submitResp.ok) {
            const errText = await submitResp.text().catch(() => '');
            throw new Error(`fal.ai/runway submit failed (${submitResp.status}): ${errText.slice(0, 200)}`);
          }

          const submit = (await submitResp.json()) as FalQueueResponse;
          if (!submit.status_url) {
            throw new Error(`fal.ai/runway submit response missing status_url: ${JSON.stringify(submit).slice(0, 200)}`);
          }

          const responseUrl = await pollUntilComplete(submit.status_url, apiKey);
          const resultResp = await fetch(responseUrl, {
            headers: { Authorization: `Key ${apiKey}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (!resultResp.ok) throw new Error(`fal.ai/runway result fetch failed: ${resultResp.status}`);

          const result = (await resultResp.json()) as FalResultResponse;
          const videoUrl = result.video?.url ?? result.data?.video?.url;
          if (!videoUrl) throw new Error(`fal.ai/runway result missing video.url: ${JSON.stringify(result).slice(0, 200)}`);

          const download = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
          if (!download.ok) throw new Error(`Couldn't download fal.ai/runway clip: HTTP ${download.status}`);
          const buffer = Buffer.from(await download.arrayBuffer());
          if (buffer.byteLength === 0) throw new Error('fal.ai/runway returned empty clip');
          return { buffer, extension: '.mp4' };
        },
      },
    );

    return {
      ...entry,
      providerName: 'fal-runway',
      generationMs: entry.cached ? 0 : Date.now() - started,
    };
  },
};
