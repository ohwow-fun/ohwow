/**
 * Seed-adapter dispatcher. Compose-core calls `getSeedAdapter(slug)` and
 * invokes the returned pickSeed with {workspace, historyDays}.
 */
import { pickSeed as briefingPick } from "./briefing-seed.mjs";
import { pickSeed as tomorrowBrokePick } from "./tomorrow-broke-seed.mjs";
import { pickSeed as mindWarsPick } from "./mind-wars-seed.mjs";
import { pickSeed as operatorModePick } from "./operator-mode-seed.mjs";

const ADAPTERS = {
  briefing: briefingPick,
  "tomorrow-broke": tomorrowBrokePick,
  "mind-wars": mindWarsPick,
  "operator-mode": operatorModePick,
  // bot-beats deferred to v2
};

export function getSeedAdapter(slug) {
  const fn = ADAPTERS[slug];
  if (!fn) {
    throw new Error(`no seed adapter for series '${slug}' — either deferred or not wired.`);
  }
  return fn;
}

export function hasSeedAdapter(slug) {
  return slug in ADAPTERS;
}
