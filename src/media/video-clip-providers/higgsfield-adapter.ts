/**
 * Higgsfield AI video-clip adapter.
 *
 * Credential resolution (first match wins):
 *   1. process.env.HIGGSFIELD_API_KEY
 *   2. ~/.ohwow/config.json { higgsfieldApiKey }
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOrCreate } from '../asset-cache.js';
import { logger } from '../../lib/logger.js';
import type { VideoClipProvider } from '../video-clip-provider.js';

function loadCreds(): { apiKey: string } {
  const envKey = process.env.HIGGSFIELD_API_KEY?.trim();
  if (envKey) return { apiKey: envKey };
  try {
    const raw = readFileSync(join(homedir(), '.ohwow', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { higgsfieldApiKey?: string };
    const fileKey = parsed.higgsfieldApiKey?.trim();
    if (fileKey) return { apiKey: fileKey };
  } catch {
    // No config file or no key. Caller will surface "unavailable".
  }
  return { apiKey: '' };
}

const POLL_MS = 3_000;
const MAX_POLLS = 100; // 5 minutes at 3s interval

interface HiggsGenerateResponse {
  generation_id?: string;
}

interface HiggsStatusResponse {
  status?: string;
  video_url?: string;
}

async function pollUntilComplete(generationId: string, apiKey: string): Promise<string> {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const resp = await fetch(`https://api.higgsfield.ai/v1/generation/${generationId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) continue;
    const data = (await resp.json()) as HiggsStatusResponse;
    if (data.status === 'completed' && data.video_url) return data.video_url;
    if (data.status === 'failed') {
      throw new Error(`Higgsfield generation failed: ${JSON.stringify(data).slice(0, 200)}`);
    }
  }
  throw new Error('Higgsfield generation timed out after 5 minutes');
}

export const higgsfieldProvider: VideoClipProvider = {
  name: 'higgsfield',
  priority: 22,
  async isAvailable() {
    return Boolean(loadCreds().apiKey);
  },
  estimateCostCents(req) {
    return Math.ceil(45 * req.durationSeconds);
  },
  async generate(req) {
    const { apiKey } = loadCreds();
    if (!apiKey) throw new Error('Higgsfield adapter unavailable (set HIGGSFIELD_API_KEY or ~/.ohwow/config.json higgsfieldApiKey)');

    const started = Date.now();
    const entry = await getOrCreate(
      'video',
      {
        provider: 'higgsfield',
        model: 'higgsfield-v1',
        prompt: req.prompt,
        durationSeconds: req.durationSeconds,
        aspectRatio: req.aspectRatio,
        seed: req.seed ?? 0,
      },
      {
        produce: async () => {
          logger.info(`[video-clip/higgsfield] submitting (${req.durationSeconds}s ${req.aspectRatio})`);
          const submitResp = await fetch('https://api.higgsfield.ai/v1/generation', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              prompt: req.prompt,
              duration: req.durationSeconds,
              aspect_ratio: req.aspectRatio,
              seed: req.seed ?? 0,
              ...(req.referenceImageUrl ? { image_url: req.referenceImageUrl } : {}),
              ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
            }),
            signal: AbortSignal.timeout(60_000),
          });

          if (!submitResp.ok) {
            const errText = await submitResp.text().catch(() => '');
            throw new Error(`Higgsfield submit failed (${submitResp.status}): ${errText.slice(0, 200)}`);
          }

          const submit = (await submitResp.json()) as HiggsGenerateResponse;
          if (!submit.generation_id) {
            throw new Error(`Higgsfield submit response missing generation_id: ${JSON.stringify(submit).slice(0, 200)}`);
          }

          const videoUrl = await pollUntilComplete(submit.generation_id, apiKey);
          const download = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
          if (!download.ok) throw new Error(`Couldn't download Higgsfield clip: HTTP ${download.status}`);
          const buffer = Buffer.from(await download.arrayBuffer());
          if (buffer.byteLength === 0) throw new Error('Higgsfield returned empty clip');
          return { buffer, extension: '.mp4' };
        },
      },
    );

    return {
      ...entry,
      providerName: 'higgsfield',
      generationMs: entry.cached ? 0 : Date.now() - started,
    };
  },
};
