/**
 * Video-clip provider protocol.
 *
 * Pluggable interface so the ohwow video engine can request AI-generated
 * clips from any backend: OpenRouter/Veo, fal.ai, Replicate, or a
 * user-owned HTTP endpoint (Modal, Fly, self-hosted). Adapters live in
 * `video-clip-providers/`. The router selects one based on availability
 * and cost.
 *
 * Contract for user-owned backends:
 *   POST <url> { prompt, duration_seconds, seed, aspect_ratio }
 *   -> video/mp4 bytes (preferred)
 *   OR application/json { url: "...", cost_cents?: number }
 *
 * See docs/remote-video-providers.md for the generic-http-adapter details.
 */
import type { CacheEntry } from './asset-cache.js';

export type VideoClipProviderName =
  | 'openrouter-veo'
  | 'fal'
  | 'fal-kling'
  | 'fal-runway'
  | 'replicate'
  | 'custom-http'
  | 'higgsfield'
  | 'heygen';

export type VideoAspectRatio = '16:9' | '9:16' | '1:1';

export type VideoProviderCreditTier = 'draft' | 'standard' | 'premium';
export type VideoProviderQuality = 'low' | 'medium' | 'high' | 'ultra';
export type VideoProviderSpeed = 'slow' | 'medium' | 'fast';
export type VideoProviderCapability =
  | 'text-to-video'
  | 'image-to-video'
  | 'avatar'
  | 'motion-brush';

/** Stable metadata describing a provider's capabilities and cost profile. */
export interface VideoProviderMeta {
  id: VideoClipProviderName;
  name: string;
  creditTier: VideoProviderCreditTier;
  quality: VideoProviderQuality;
  speed: VideoProviderSpeed;
  /** Maximum supported clip length in seconds. */
  maxDuration: number;
  supportedAspectRatios: VideoAspectRatio[];
  capabilities: VideoProviderCapability[];
  /** Lower = preferred in cost-aware routing. */
  priority: number;
}

/** Seedance / Bytedance 5-block cinematic prompt structure. */
export interface SeedancePromptBlock {
  subject: string;
  action: string;
  camera: string;
  style: string;
  qualitySuffix?: string;
}

/** Compose a Seedance 5-block prompt into a single string. */
export function composeSeedancePrompt(block: SeedancePromptBlock): string {
  const parts = [block.subject, block.action, block.camera, block.style];
  if (block.qualitySuffix) parts.push(block.qualitySuffix);
  return parts.filter(Boolean).join('. ');
}

export interface VideoClipRequest {
  prompt: string;
  /** 2–10 seconds. Adapters clamp to their model's supported range. */
  durationSeconds: number;
  aspectRatio: VideoAspectRatio;
  /** Stable seed for deterministic caching. Defaults to 0. */
  seed?: number;
  /** Optional image-to-video reference. */
  referenceImageUrl?: string;
  negativePrompt?: string;
  /** Structured Seedance prompt. When set, adapters that support it will use
   *  composeSeedancePrompt() instead of the plain prompt string. */
  seedancePrompt?: SeedancePromptBlock;
}

export interface VideoClipResult extends CacheEntry {
  providerName: VideoClipProviderName;
  /** Per-clip cost the backend reported, if known. */
  costCents?: number;
  /** Wall-clock time spent generating (0 on cache hit). */
  generationMs: number;
}

export interface VideoClipProvider {
  name: VideoClipProviderName;
  /** Metadata describing this provider's capabilities and cost profile. */
  meta: VideoProviderMeta;
  /** Lower = preferred. Typical order: free local < pay-per-use < premium. */
  priority: number;
  /** Fast probe — shouldn't make network calls when env is clearly missing. */
  isAvailable(): Promise<boolean>;
  /** Cents per call. Used by the router to compare providers and honor caps. */
  estimateCostCents(req: VideoClipRequest): number;
  generate(req: VideoClipRequest): Promise<VideoClipResult>;
}

/** Stable, minimal snapshot of a provider for logging/telemetry. */
export interface ProviderInfo {
  name: VideoClipProviderName;
  priority: number;
  estimatedCostCents: number;
  meta: VideoProviderMeta;
}
