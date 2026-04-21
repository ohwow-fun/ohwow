/**
 * HeyGen video adapter.
 *
 * Integrates two ways:
 *   1. VideoClipProvider — routes through the clip system; prompt = spoken script.
 *   2. generateAvatarVideo() — direct call with full avatar/voice control (used by
 *      `ohwow video avatar`).
 *
 * Credential resolution (first match wins):
 *   1. process.env.HEYGEN_API_KEY / HEYGEN_AVATAR_ID
 *   2. ~/.ohwow/config.json { heygenApiKey, heygenAvatarId }
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOrCreate } from '../asset-cache.js';
import { logger } from '../../lib/logger.js';
import type { VideoClipProvider, VideoAspectRatio } from '../video-clip-provider.js';

interface HeyGenCreds {
  apiKey: string;
  avatarId: string;
}

function loadCreds(): HeyGenCreds {
  const envKey = process.env.HEYGEN_API_KEY?.trim();
  const envAvatar = process.env.HEYGEN_AVATAR_ID?.trim();
  if (envKey) return { apiKey: envKey, avatarId: envAvatar ?? '' };
  try {
    const raw = readFileSync(join(homedir(), '.ohwow', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { heygenApiKey?: string; heygenAvatarId?: string };
    const fileKey = parsed.heygenApiKey?.trim();
    if (fileKey) return { apiKey: fileKey, avatarId: envAvatar ?? parsed.heygenAvatarId?.trim() ?? '' };
  } catch {
    // No config file or no key.
  }
  return { apiKey: '', avatarId: envAvatar ?? '' };
}

const POLL_MS = 4_000;
const MAX_POLLS = 150; // 10 minutes at 4s interval

interface HeyGenGenerateResponse {
  data?: { video_id?: string };
  error?: string;
}

interface HeyGenStatusResponse {
  data?: { status?: string; video_url?: string; error?: string };
  error?: string;
}

async function pollUntilComplete(videoId: string, apiKey: string): Promise<string> {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const resp = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) continue;
    const data = (await resp.json()) as HeyGenStatusResponse;
    const status = data.data?.status;
    if (status === 'completed' && data.data?.video_url) return data.data.video_url;
    if (status === 'failed') {
      throw new Error(`HeyGen generation failed: ${data.data?.error ?? JSON.stringify(data).slice(0, 200)}`);
    }
  }
  throw new Error('HeyGen generation timed out after 10 minutes');
}

export interface AvatarVideoRequest {
  apiKey: string;
  avatarId: string;
  voiceId?: string;
  script: string;
  aspectRatio: VideoAspectRatio;
  backgroundUrl?: string;
}

export interface AvatarVideoResult {
  buffer: Buffer;
  videoId: string;
}

export async function generateAvatarVideo(req: AvatarVideoRequest): Promise<AvatarVideoResult> {
  const voiceConfig = req.voiceId
    ? { type: 'voice', voice_id: req.voiceId }
    : { type: 'text', input_text: req.script, speed: 1.0 };

  const body: Record<string, unknown> = {
    video_inputs: [
      {
        character: { type: 'avatar', avatar_id: req.avatarId },
        voice: voiceConfig,
        ...(req.backgroundUrl ? { background: { type: 'image', url: req.backgroundUrl } } : {}),
      },
    ],
    aspect_ratio: req.aspectRatio,
    test: false,
  };

  const submitResp = await fetch('https://api.heygen.com/v2/video/generate', {
    method: 'POST',
    headers: {
      'X-Api-Key': req.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!submitResp.ok) {
    const errText = await submitResp.text().catch(() => '');
    throw new Error(`HeyGen submit failed (${submitResp.status}): ${errText.slice(0, 200)}`);
  }

  const submit = (await submitResp.json()) as HeyGenGenerateResponse;
  const videoId = submit.data?.video_id;
  if (!videoId) {
    throw new Error(`HeyGen submit response missing video_id: ${JSON.stringify(submit).slice(0, 200)}`);
  }

  const videoUrl = await pollUntilComplete(videoId, req.apiKey);
  const download = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
  if (!download.ok) throw new Error(`Couldn't download HeyGen clip: HTTP ${download.status}`);
  const buffer = Buffer.from(await download.arrayBuffer());
  if (buffer.byteLength === 0) throw new Error('HeyGen returned empty clip');
  return { buffer, videoId };
}

export const heygenProvider: VideoClipProvider = {
  name: 'heygen',
  priority: 35,
  async isAvailable() {
    const { apiKey, avatarId } = loadCreds();
    return Boolean(apiKey) && Boolean(avatarId);
  },
  estimateCostCents(req) {
    return Math.ceil(15 * req.durationSeconds);
  },
  async generate(req) {
    const { apiKey, avatarId } = loadCreds();
    if (!apiKey) throw new Error('HeyGen adapter unavailable (set HEYGEN_API_KEY or ~/.ohwow/config.json heygenApiKey)');
    if (!avatarId) throw new Error('HeyGen adapter unavailable (set HEYGEN_AVATAR_ID or ~/.ohwow/config.json heygenAvatarId)');

    const started = Date.now();
    const entry = await getOrCreate(
      'video',
      {
        provider: 'heygen',
        model: `heygen-avatar-${avatarId}`,
        prompt: req.prompt,
        durationSeconds: req.durationSeconds,
        aspectRatio: req.aspectRatio,
        seed: req.seed ?? 0,
      },
      {
        produce: async () => {
          logger.info(`[video-clip/heygen] submitting avatar=${avatarId} (${req.aspectRatio})`);
          const { buffer } = await generateAvatarVideo({
            apiKey,
            avatarId,
            script: req.prompt,
            aspectRatio: req.aspectRatio,
          });
          return { buffer, extension: '.mp4' };
        },
      },
    );

    return {
      ...entry,
      providerName: 'heygen',
      generationMs: entry.cached ? 0 : Date.now() - started,
    };
  },
};
