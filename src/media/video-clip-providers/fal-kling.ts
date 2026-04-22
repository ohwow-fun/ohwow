/**
 * fal.ai Kling v2 video-clip adapter.
 *
 * Standalone provider for Kling v2 Master — the cloud's default T2V/I2V
 * model. Shares credential resolution with fal-adapter but targets Kling
 * specifically so the router can pick it independently of FAL_VIDEO_MODEL.
 *
 * Env:
 *   FAL_KEY         fal.ai API key (required)
 *   FAL_KLING_MODEL optional override (default: fal-ai/kling-video/v2/master/text-to-video)
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOrCreate } from '../asset-cache.js';
import { logger } from '../../lib/logger.js';
import type { VideoClipProvider, VideoProviderMeta } from '../video-clip-provider.js';

const DEFAULT_T2V_MODEL = 'fal-ai/kling-video/v2/master/text-to-video';
const DEFAULT_I2V_MODEL = 'fal-ai/kling-video/v2/master/image-to-video';

function loadCreds(): { apiKey: string; model: string; i2vModel: string } {
  const envKey = process.env.FAL_KEY?.trim();
  const envModel = process.env.FAL_KLING_MODEL?.trim();
  if (envKey) return { apiKey: envKey, model: envModel || DEFAULT_T2V_MODEL, i2vModel: DEFAULT_I2V_MODEL };
  try {
    const raw = readFileSync(join(homedir(), '.ohwow', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { falKey?: string };
    const fileKey = parsed.falKey?.trim();
    if (fileKey) return { apiKey: fileKey, model: envModel || DEFAULT_T2V_MODEL, i2vModel: DEFAULT_I2V_MODEL };
  } catch {
    // No config file. Caller will surface "unavailable".
  }
  return { apiKey: '', model: DEFAULT_T2V_MODEL, i2vModel: DEFAULT_I2V_MODEL };
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
      throw new Error(`fal.ai/kling job failed: ${JSON.stringify(data).slice(0, 200)}`);
    }
  }
  throw new Error('fal.ai/kling job timed out after 5 minutes');
}

const KLING_META: VideoProviderMeta = {
  id: 'fal-kling',
  name: 'Kling v2 (fal.ai)',
  creditTier: 'standard',
  quality: 'high',
  speed: 'medium',
  maxDuration: 10,
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  capabilities: ['text-to-video', 'image-to-video'],
  priority: 21,
};

export const falKlingProvider: VideoClipProvider = {
  name: 'fal-kling',
  meta: KLING_META,
  priority: 21,
  async isAvailable() {
    return Boolean(loadCreds().apiKey);
  },
  estimateCostCents(req) {
    // Kling v2: ~$0.40/sec
    return Math.ceil(40 * req.durationSeconds);
  },
  async generate(req) {
    const { apiKey, model, i2vModel } = loadCreds();
    if (!apiKey) throw new Error('fal-kling adapter unavailable (set FAL_KEY or ~/.ohwow/config.json falKey)');

    const selectedModel = req.referenceImageUrl ? i2vModel : model;
    const started = Date.now();
    const entry = await getOrCreate(
      'video',
      {
        provider: 'fal-kling',
        model: selectedModel,
        prompt: req.prompt,
        durationSeconds: req.durationSeconds,
        aspectRatio: req.aspectRatio,
        seed: req.seed ?? 0,
      },
      {
        produce: async () => {
          logger.info(`[video-clip/fal-kling] submitting to ${selectedModel} (${req.durationSeconds}s ${req.aspectRatio})`);
          const body: Record<string, unknown> = {
            prompt: req.prompt,
            aspect_ratio: req.aspectRatio,
            duration: String(req.durationSeconds) as '5' | '10',
            seed: req.seed ?? 0,
          };
          if (req.referenceImageUrl) body.image_url = req.referenceImageUrl;
          if (req.negativePrompt) body.negative_prompt = req.negativePrompt;

          const submitResp = await fetch(`https://queue.fal.run/${selectedModel}`, {
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
            throw new Error(`fal.ai/kling submit failed (${submitResp.status}): ${errText.slice(0, 200)}`);
          }

          const submit = (await submitResp.json()) as FalQueueResponse;
          if (!submit.status_url) {
            throw new Error(`fal.ai/kling submit response missing status_url: ${JSON.stringify(submit).slice(0, 200)}`);
          }

          const responseUrl = await pollUntilComplete(submit.status_url, apiKey);
          const resultResp = await fetch(responseUrl, {
            headers: { Authorization: `Key ${apiKey}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (!resultResp.ok) throw new Error(`fal.ai/kling result fetch failed: ${resultResp.status}`);

          const result = (await resultResp.json()) as FalResultResponse;
          const videoUrl = result.video?.url ?? result.data?.video?.url;
          if (!videoUrl) throw new Error(`fal.ai/kling result missing video.url: ${JSON.stringify(result).slice(0, 200)}`);

          const download = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
          if (!download.ok) throw new Error(`Couldn't download fal.ai/kling clip: HTTP ${download.status}`);
          const buffer = Buffer.from(await download.arrayBuffer());
          if (buffer.byteLength === 0) throw new Error('fal.ai/kling returned empty clip');
          return { buffer, extension: '.mp4' };
        },
      },
    );

    return {
      ...entry,
      providerName: 'fal-kling',
      generationMs: entry.cached ? 0 : Date.now() - started,
    };
  },
};
