/**
 * Shared shape for per-series prompt modules.
 *
 * Each series ships a TS module under `./<slug>-prompt.ts` that the compose
 * pipeline imports at runtime via the registry. The prompt module is the
 * authoritative source of truth for that show's voice and format; the
 * show bible in `docs/youtube/` is the human-readable mirror.
 */

import type { SeriesSlug } from "../registry.js";

/**
 * Loose seed shape. Adapters are free to include more fields; prompt modules
 * only read what they need.
 */
export interface SeriesSeed {
  /** Where the seed came from. Drives citation style in the final narration. */
  kind: "x-intel" | "prediction" | "knowledge" | "external-url" | "internal-archive";

  /** Short summary the compose pipeline can log without leaking the full payload. */
  title: string;

  /**
   * The seed payload, formatted as the adapter sees fit. Prompt modules paste
   * this into the user prompt verbatim; trust the adapter to strip self-
   * references and junk.
   */
  body: string;

  /** Optional attribution. When present, prompt modules may cite by @handle. */
  citations?: Array<{
    handle?: string;
    url?: string;
    text?: string;
  }>;

  /**
   * Free-form side-channel. Adapters pass through things like
   * `bucket`, `prediction_confidence`, `source_doc_id`, etc.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Shape every prompt module exports as `promptModule`. The compose pipeline
 * reads these fields and never reaches into anything else.
 */
export interface SeriesPromptModule {
  slug: SeriesSlug;

  /**
   * System prompt the LLM sees. Should encode voice, format contract, banned
   * list, self-check, and required output shape.
   */
  systemPrompt: string;

  /**
   * Series-specific banned phrases. Applied on top of the global banned list
   * (which is owned by compose-core). A draft containing any of these is
   * skipped, not sent to approval.
   */
  bannedPhrases: string[];

  /**
   * Builds the per-draft user prompt from a seed. Kept as a function (not a
   * string template) so each series can reshape the seed to its own format
   * contract without leaking other series' conventions.
   */
  buildUserPrompt(seed: SeriesSeed): string;

  /**
   * Confidence floor below which the draft is skipped rather than sent to
   * approval. Default 0.4; Operator Mode may want stricter.
   */
  confidenceFloor?: number;
}
