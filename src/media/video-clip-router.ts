/**
 * Video-clip router.
 *
 * Probes configured providers (via env vars) and picks one per request
 * honoring cost caps and explicit preferences. Mirrors media-router.ts
 * but for the content-addressed VideoClipProvider interface.
 */
import { logger } from '../lib/logger.js';
import { genericHttpProvider } from './video-clip-providers/generic-http-adapter.js';
import { openrouterVeoProvider } from './video-clip-providers/openrouter-veo.js';
import { falProvider } from './video-clip-providers/fal-adapter.js';
import { replicateProvider } from './video-clip-providers/replicate-adapter.js';
import { higgsfieldProvider } from './video-clip-providers/higgsfield-adapter.js';
import { heygenProvider } from './video-clip-providers/heygen-adapter.js';
import type {
  ProviderInfo,
  VideoClipProvider,
  VideoClipProviderName,
  VideoClipRequest,
  VideoClipResult,
} from './video-clip-provider.js';

export interface RouterOptions {
  /** If set, only this provider will be used. */
  forceProvider?: VideoClipProviderName;
  /** Skip any provider whose estimated cost exceeds this cap. */
  maxCostCents?: number;
  /** If true, return a stubbed result describing what would run — no API call. */
  dryRun?: boolean;
  /** Extra providers to consider (tests, custom in-process stubs). */
  extraProviders?: VideoClipProvider[];
}

const BUILT_IN: VideoClipProvider[] = [
  genericHttpProvider,
  falProvider,
  higgsfieldProvider,
  replicateProvider,
  openrouterVeoProvider,
  heygenProvider,
];

export async function listAvailableProviders(
  extraProviders: VideoClipProvider[] = [],
): Promise<VideoClipProvider[]> {
  const all = [...BUILT_IN, ...extraProviders];
  const checks = await Promise.all(
    all.map(async p => ({ p, ok: await p.isAvailable().catch(() => false) })),
  );
  return checks.filter(c => c.ok).map(c => c.p);
}

export async function pickProvider(
  req: VideoClipRequest,
  opts: RouterOptions = {},
): Promise<VideoClipProvider | null> {
  const candidates = await listAvailableProviders(opts.extraProviders);
  if (candidates.length === 0) return null;

  const filtered = opts.forceProvider
    ? candidates.filter(p => p.name === opts.forceProvider)
    : candidates;

  if (filtered.length === 0) {
    logger.warn(`[video-clip/router] requested provider "${opts.forceProvider}" not available`);
    return null;
  }

  const sorted = filtered.slice().sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.estimateCostCents(req) - b.estimateCostCents(req);
  });

  for (const p of sorted) {
    if (opts.maxCostCents != null && p.estimateCostCents(req) > opts.maxCostCents) {
      logger.info(
        `[video-clip/router] skipping ${p.name}: est ${p.estimateCostCents(req)}¢ > cap ${opts.maxCostCents}¢`,
      );
      continue;
    }
    return p;
  }
  return null;
}

export async function previewRoute(
  req: VideoClipRequest,
  opts: RouterOptions = {},
): Promise<ProviderInfo[]> {
  const candidates = await listAvailableProviders(opts.extraProviders);
  return candidates.map(p => ({
    name: p.name,
    priority: p.priority,
    estimatedCostCents: p.estimateCostCents(req),
  }));
}

export interface RoutedGenerateResult {
  result?: VideoClipResult;
  chosen?: VideoClipProviderName;
  skipped: 'no-provider' | 'dry-run' | null;
  preview: ProviderInfo[];
}

export async function generateClip(
  req: VideoClipRequest,
  opts: RouterOptions = {},
): Promise<RoutedGenerateResult> {
  const preview = await previewRoute(req, opts);

  if (opts.dryRun) {
    const would = await pickProvider(req, opts);
    return { chosen: would?.name, skipped: 'dry-run', preview };
  }

  const provider = await pickProvider(req, opts);
  if (!provider) return { skipped: 'no-provider', preview };

  const result = await provider.generate(req);
  return { result, chosen: provider.name, skipped: null, preview };
}
