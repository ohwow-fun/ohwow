/**
 * Generic HTTP video-clip adapter — the public/private bridge.
 *
 * Zero backend-specific code: env vars alone point ohwow at any HTTP
 * endpoint that follows this contract:
 *
 *   POST  <OHWOW_VIDEO_HTTP_URL>
 *   Headers: <OHWOW_VIDEO_HTTP_AUTH_HEADER>: [<scheme> ]<OHWOW_VIDEO_HTTP_AUTH>
 *   Body:   JSON (default or user-supplied template)
 *   -> video/mp4 bytes   (preferred — single round trip)
 *   -> application/json  { url, cost_cents? }  (URL is fetched server-side)
 *
 * Env:
 *   OHWOW_VIDEO_HTTP_URL               Endpoint URL (required)
 *   OHWOW_VIDEO_HTTP_AUTH              Auth value (required unless backend is public)
 *   OHWOW_VIDEO_HTTP_AUTH_HEADER       Header name (default "Authorization")
 *   OHWOW_VIDEO_HTTP_AUTH_SCHEME       Prefix for the value (default "Bearer "
 *                                      when header is Authorization, else empty)
 *   OHWOW_VIDEO_HTTP_PAYLOAD_TEMPLATE  JSON with {{prompt}}, {{duration}},
 *                                      {{seed}}, {{aspect_ratio}} placeholders.
 *                                      Default sends all four top-level.
 *   OHWOW_VIDEO_HTTP_RESPONSE_URL_PATH Dot-path to mp4 URL in JSON response
 *                                      (default "url"). Ignored for mp4 bytes.
 *   OHWOW_VIDEO_HTTP_COST_PATH         Dot-path to cost in cents (default "cost_cents")
 *   OHWOW_VIDEO_HTTP_COST_PER_SECOND   Static cost estimate (cents/sec) for the
 *                                      router when the backend doesn't report one.
 *   OHWOW_VIDEO_HTTP_TIMEOUT_MS        Request timeout (default 300000)
 */
import { getOrCreate } from '../asset-cache.js';
import { logger } from '../../lib/logger.js';
import type {
  VideoClipProvider,
  VideoClipRequest,
  VideoClipResult,
  VideoProviderMeta,
} from '../video-clip-provider.js';

const DEFAULT_TIMEOUT_MS = 300_000;

interface AdapterConfig {
  url: string;
  auth: string;
  authHeader: string;
  authScheme: string;
  payloadTemplate: string | null;
  responseUrlPath: string;
  costPath: string;
  costPerSecond: number | null;
  timeoutMs: number;
}

function readConfig(): AdapterConfig | null {
  const url = process.env.OHWOW_VIDEO_HTTP_URL?.trim();
  if (!url) return null;
  const authHeader = process.env.OHWOW_VIDEO_HTTP_AUTH_HEADER?.trim() || 'Authorization';
  const defaultScheme = authHeader.toLowerCase() === 'authorization' ? 'Bearer ' : '';
  const authScheme = process.env.OHWOW_VIDEO_HTTP_AUTH_SCHEME ?? defaultScheme;
  const timeoutRaw = Number(process.env.OHWOW_VIDEO_HTTP_TIMEOUT_MS);
  const costRaw = Number(process.env.OHWOW_VIDEO_HTTP_COST_PER_SECOND);
  return {
    url,
    auth: process.env.OHWOW_VIDEO_HTTP_AUTH?.trim() ?? '',
    authHeader,
    authScheme,
    payloadTemplate: process.env.OHWOW_VIDEO_HTTP_PAYLOAD_TEMPLATE?.trim() || null,
    responseUrlPath: process.env.OHWOW_VIDEO_HTTP_RESPONSE_URL_PATH?.trim() || 'url',
    costPath: process.env.OHWOW_VIDEO_HTTP_COST_PATH?.trim() || 'cost_cents',
    costPerSecond: Number.isFinite(costRaw) && costRaw > 0 ? costRaw : null,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
  };
}

/** JSON.parse a template and substitute {{placeholders}} inside string leaves. */
function buildPayload(template: string | null, req: VideoClipRequest): unknown {
  const ctx: Record<string, string | number> = {
    prompt: req.prompt,
    duration: req.durationSeconds,
    seed: req.seed ?? 0,
    aspect_ratio: req.aspectRatio,
    reference_image_url: req.referenceImageUrl ?? '',
    negative_prompt: req.negativePrompt ?? '',
  };

  if (!template) {
    const out: Record<string, unknown> = {
      prompt: req.prompt,
      duration_seconds: req.durationSeconds,
      aspect_ratio: req.aspectRatio,
      seed: req.seed ?? 0,
    };
    if (req.referenceImageUrl) out.reference_image_url = req.referenceImageUrl;
    if (req.negativePrompt) out.negative_prompt = req.negativePrompt;
    return out;
  }

  const parsed = JSON.parse(template) as unknown;
  return substitute(parsed, ctx);
}

function substitute(value: unknown, ctx: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (_, key) =>
      key in ctx ? String(ctx[key]) : `{{${key}}}`,
    );
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitute(v, ctx);
    }
    return out;
  }
  return value;
}

function readPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

async function fetchMp4(url: string, timeoutMs: number): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) {
    throw new Error(`Couldn't download clip from ${url}: HTTP ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) throw new Error(`Clip download from ${url} was empty`);
  return buf;
}

async function callBackend(
  cfg: AdapterConfig,
  req: VideoClipRequest,
): Promise<{ buffer: Buffer; costCents?: number }> {
  const body = buildPayload(cfg.payloadTemplate, req);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.auth) headers[cfg.authHeader] = `${cfg.authScheme}${cfg.auth}`;

  const resp = await fetch(cfg.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Video HTTP backend ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  const costFromHeader = Number(resp.headers.get('x-cost-cents'));
  const costCents = Number.isFinite(costFromHeader) && costFromHeader > 0 ? costFromHeader : undefined;

  if (contentType.startsWith('video/') || contentType === 'application/octet-stream') {
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.byteLength === 0) throw new Error('Backend returned empty video body');
    return { buffer, costCents };
  }

  if (contentType.includes('application/json')) {
    const data = (await resp.json()) as unknown;
    const mp4Url = readPath(data, cfg.responseUrlPath);
    if (typeof mp4Url !== 'string' || !mp4Url) {
      throw new Error(`Backend JSON missing "${cfg.responseUrlPath}" — got: ${JSON.stringify(data).slice(0, 200)}`);
    }
    const reportedCost = readPath(data, cfg.costPath);
    const buffer = await fetchMp4(mp4Url, cfg.timeoutMs);
    return {
      buffer,
      costCents: typeof reportedCost === 'number' ? reportedCost : costCents,
    };
  }

  throw new Error(`Unexpected Content-Type "${contentType}" from video backend`);
}

const GENERIC_HTTP_META: VideoProviderMeta = {
  id: 'custom-http',
  name: 'Custom HTTP Provider',
  creditTier: 'draft',
  quality: 'medium',
  speed: 'fast',
  maxDuration: 30,
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  capabilities: ['text-to-video'],
  priority: 10,
};

export const genericHttpProvider: VideoClipProvider = {
  name: 'custom-http',
  meta: GENERIC_HTTP_META,
  priority: 10,
  async isAvailable() {
    return readConfig() !== null;
  },
  estimateCostCents(req) {
    const cfg = readConfig();
    const perSec = cfg?.costPerSecond ?? 0;
    return Math.ceil(perSec * req.durationSeconds);
  },
  async generate(req) {
    const cfg = readConfig();
    if (!cfg) throw new Error('custom-http provider unavailable (OHWOW_VIDEO_HTTP_URL unset)');

    let reportedCost: number | undefined;
    const started = Date.now();

    const entry = await getOrCreate(
      'video',
      {
        provider: 'custom-http',
        endpoint: cfg.url,
        prompt: req.prompt,
        durationSeconds: req.durationSeconds,
        aspectRatio: req.aspectRatio,
        seed: req.seed ?? 0,
        referenceImageUrl: req.referenceImageUrl,
        negativePrompt: req.negativePrompt,
      },
      {
        produce: async () => {
          logger.info(
            `[video-clip/http] generating ${req.durationSeconds}s ${req.aspectRatio} clip via ${cfg.url}`,
          );
          const { buffer, costCents } = await callBackend(cfg, req);
          reportedCost = costCents;
          return { buffer, extension: '.mp4' };
        },
      },
    );

    return {
      ...entry,
      providerName: 'custom-http',
      costCents: reportedCost,
      generationMs: entry.cached ? 0 : Date.now() - started,
    };
  },
};
