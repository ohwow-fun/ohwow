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
  | 'replicate'
  | 'custom-http'
  | 'higgsfield'
  | 'heygen';

export type VideoAspectRatio = '16:9' | '9:16' | '1:1';

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
}
