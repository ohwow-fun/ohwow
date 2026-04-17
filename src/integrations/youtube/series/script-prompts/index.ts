/**
 * Dispatch table for per-series prompt modules. Compose-core reads by slug
 * and never imports individual modules directly — that keeps the add-a-
 * new-series surface to a single file.
 */
import type { SeriesSlug } from "../registry.js";
import type { SeriesPromptModule } from "./types.js";

import { briefingPrompt } from "./briefing-prompt.js";
import { tomorrowBrokePrompt } from "./tomorrow-broke-prompt.js";
import { mindWarsPrompt } from "./mind-wars-prompt.js";
import { operatorModePrompt } from "./operator-mode-prompt.js";

export type { SeriesPromptModule, SeriesSeed } from "./types.js";

const ENABLED_MODULES: Partial<Record<SeriesSlug, SeriesPromptModule>> = {
  briefing: briefingPrompt,
  "tomorrow-broke": tomorrowBrokePrompt,
  "mind-wars": mindWarsPrompt,
  "operator-mode": operatorModePrompt,
  // bot-beats deferred to v2
};

export function getPromptModule(slug: SeriesSlug): SeriesPromptModule {
  const mod = ENABLED_MODULES[slug];
  if (!mod) {
    throw new Error(
      `no prompt module for series '${slug}' — either it's deferred (bot-beats) or the module file is missing.`,
    );
  }
  return mod;
}

export function hasPromptModule(slug: SeriesSlug): boolean {
  return slug in ENABLED_MODULES;
}
