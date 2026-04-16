/**
 * Replicate video-clip adapter.
 *
 * Works with any Replicate text-to-video model via Predictions API.
 * Good defaults: minimax/video-01, kwaivgi/kling-v1.6-standard, lucataco/ltx-video.
 *
 * Env:
 *   REPLICATE_API_TOKEN      API token (required)
 *   REPLICATE_VIDEO_MODEL    model owner/name[:version] (required)
 */
import { getOrCreate } from '../asset-cache.js';
import { logger } from '../../lib/logger.js';
import type { VideoClipProvider } from '../video-clip-provider.js';

const POLL_INTERVAL_MS = 2_500;
const MAX_POLLS = 120;

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[];
  error?: string | null;
  urls?: { get?: string };
}

function parseModel(modelRef: string): { owner: string; name: string; version?: string } {
  const [slug, version] = modelRef.split(':');
  const [owner, name] = slug.split('/');
  if (!owner || !name) throw new Error(`REPLICATE_VIDEO_MODEL must be "owner/name[:version]" — got "${modelRef}"`);
  return { owner, name, version };
}

async function pollPrediction(getUrl: string, token: string): Promise<ReplicatePrediction> {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const resp = await fetch(getUrl, {
      headers: { Authorization: `Token ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) continue;
    const pred = (await resp.json()) as ReplicatePrediction;
    if (pred.status === 'succeeded') return pred;
    if (pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`Replicate prediction ${pred.status}: ${pred.error ?? 'unknown'}`);
    }
  }
  throw new Error('Replicate prediction timed out');
}

export const replicateProvider: VideoClipProvider = {
  name: 'replicate',
  priority: 25,
  async isAvailable() {
    return Boolean(
      process.env.REPLICATE_API_TOKEN?.trim() && process.env.REPLICATE_VIDEO_MODEL?.trim(),
    );
  },
  estimateCostCents(req) {
    // Replicate bills by GPU-second and varies wildly per model. A conservative
    // estimate of ~$0.30/sec of output keeps the router from picking it over
    // local/custom providers.
    return Math.ceil(30 * req.durationSeconds);
  },
  async generate(req) {
    const token = process.env.REPLICATE_API_TOKEN?.trim();
    const modelRef = process.env.REPLICATE_VIDEO_MODEL?.trim();
    if (!token || !modelRef) {
      throw new Error('replicate adapter unavailable (REPLICATE_API_TOKEN or REPLICATE_VIDEO_MODEL unset)');
    }
    const { owner, name, version } = parseModel(modelRef);

    const started = Date.now();
    const entry = await getOrCreate(
      'video',
      {
        provider: 'replicate',
        model: modelRef,
        prompt: req.prompt,
        durationSeconds: req.durationSeconds,
        aspectRatio: req.aspectRatio,
        seed: req.seed ?? 0,
      },
      {
        produce: async () => {
          const input: Record<string, unknown> = {
            prompt: req.prompt,
            aspect_ratio: req.aspectRatio,
            duration: req.durationSeconds,
            seed: req.seed ?? 0,
          };
          if (req.referenceImageUrl) input.image = req.referenceImageUrl;
          if (req.negativePrompt) input.negative_prompt = req.negativePrompt;

          logger.info(`[video-clip/replicate] submitting to ${modelRef}`);
          const endpoint = version
            ? 'https://api.replicate.com/v1/predictions'
            : `https://api.replicate.com/v1/models/${owner}/${name}/predictions`;
          const body = version ? { version, input } : { input };

          const submit = await fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Token ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
          });
          if (!submit.ok) {
            const errText = await submit.text().catch(() => '');
            throw new Error(`Replicate submit failed (${submit.status}): ${errText.slice(0, 200)}`);
          }

          const pred = (await submit.json()) as ReplicatePrediction;
          const getUrl = pred.urls?.get;
          if (!getUrl) throw new Error('Replicate response missing urls.get');
          const done = await pollPrediction(getUrl, token);

          const videoUrl = Array.isArray(done.output) ? done.output[0] : done.output;
          if (typeof videoUrl !== 'string' || !videoUrl) {
            throw new Error(`Replicate output not a URL: ${JSON.stringify(done.output).slice(0, 200)}`);
          }

          const download = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
          if (!download.ok) throw new Error(`Couldn't download Replicate clip: HTTP ${download.status}`);
          const buffer = Buffer.from(await download.arrayBuffer());
          if (buffer.byteLength === 0) throw new Error('Replicate returned empty clip');
          return { buffer, extension: '.mp4' };
        },
      },
    );

    return {
      ...entry,
      providerName: 'replicate',
      generationMs: entry.cached ? 0 : Date.now() - started,
    };
  },
};
