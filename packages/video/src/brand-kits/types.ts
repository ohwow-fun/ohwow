/**
 * BrandKit — the per-series visual identity layer that overlays the default
 * brand tokens at compose time. One JSON file per series lives under
 * `packages/video/brand-kits/<slug>.json`; compose-core loads the JSON and
 * merges it onto the VideoSpec before render.
 *
 * Keep this type JSON-friendly (no TS-only constructs) so the `.mjs` compose
 * scripts can `JSON.parse` the files and trust the shape.
 */

import type { BrandTokens } from "../spec/types";

export type SceneMood =
  | "contemplative"
  | "electric"
  | "warm"
  | "cosmic"
  | "ethereal"
  | "noir"
  | "dawn";

export type MotionStyle =
  | "crisp"
  | "slow-burn"
  | "measured"
  | "punchy"
  | "chaotic";

export interface BrandKit extends BrandTokens {
  slug: string;
  displayName: string;

  /** Default ambient mood when the LLM doesn't pick one. Drives music routing. */
  ambientMoodDefault: SceneMood;

  /**
   * Allowlist of scene kinds the composer may use for this series. Empty or
   * missing = all registered kinds allowed. Briefing restricts to newsroom-
   * friendly kinds; Bot Beats will open everything up.
   */
  sceneKindAllowlist?: string[];

  /**
   * Preferred visual primitives for composable scenes. Compose-core seeds
   * these into the prompt so the LLM picks series-consistent layers.
   */
  primitivePalette: string[];

  /** Hint that transitions / pacing / spring-damping can honor. */
  motionStyle: MotionStyle;

  /** Palette generation hints. Used when the draft doesn't supply its own. */
  paletteHue: number;
  paletteHarmony: "analogous" | "complementary" | "triadic" | "split";

  /**
   * Optional headline font (CSS family). Distinct from `fonts.display` so
   * series with three font layers (editorial headline + body sans + mono
   * labels) can express that without overloading `display`.
   */
  headlineFont?: string;
}
