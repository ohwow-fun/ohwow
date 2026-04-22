/**
 * OpenRouter video provider — wraps LyriaOpenRouterBridge.generateVideo()
 * so the Veo 2 model slots into the video-clip protocol.
 */
import { readFile, unlink } from 'node:fs/promises';
import { getOrCreate } from '../asset-cache.js';
import { LyriaOpenRouterBridge } from '../lyria-openrouter-bridge.js';
import { logger } from '../../lib/logger.js';
import type { VideoClipProvider, VideoProviderMeta } from '../video-clip-provider.js';

function readApiKey(): string | null {
  return (process.env.OPENROUTER_API_KEY?.trim() || null);
}

const OPENROUTER_VEO_META: VideoProviderMeta = {
  id: 'openrouter-veo',
  name: 'Google Veo 2 (OpenRouter)',
  creditTier: 'premium',
  quality: 'ultra',
  speed: 'slow',
  maxDuration: 8,
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  capabilities: ['text-to-video'],
  priority: 30,
};

export const openrouterVeoProvider: VideoClipProvider = {
  name: 'openrouter-veo',
  meta: OPENROUTER_VEO_META,
  priority: 30,
  async isAvailable() {
    return readApiKey() !== null;
  },
  estimateCostCents(req) {
    // Veo 2 on OpenRouter: ~$0.50 per second, premium tier.
    return Math.ceil(50 * req.durationSeconds);
  },
  async generate(req) {
    const apiKey = readApiKey();
    if (!apiKey) throw new Error('openrouter-veo unavailable (OPENROUTER_API_KEY unset)');

    const started = Date.now();
    const bridge = new LyriaOpenRouterBridge({ apiKey });

    const entry = await getOrCreate(
      'video',
      {
        provider: 'openrouter-veo',
        model: 'google/veo-2',
        prompt: req.prompt,
        durationSeconds: req.durationSeconds,
        aspectRatio: req.aspectRatio,
        seed: req.seed ?? 0,
      },
      {
        produce: async () => {
          logger.info(`[video-clip/veo] generating ${req.durationSeconds}s ${req.aspectRatio} clip`);
          const result = await bridge.generateVideo({
            prompt: req.prompt,
            durationSeconds: req.durationSeconds,
            aspectRatio: req.aspectRatio,
          });
          const buffer = await readFile(result.path);
          // The bridge already persisted a copy under ~/.ohwow/media/video/.
          // We re-cache with our content-addressed hash and drop the duplicate.
          await unlink(result.path).catch(() => { /* best effort */ });
          return { buffer, extension: '.mp4' };
        },
      },
    );

    return {
      ...entry,
      providerName: 'openrouter-veo',
      generationMs: entry.cached ? 0 : Date.now() - started,
    };
  },
};
