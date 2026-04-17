#!/usr/bin/env node
/**
 * Dev harness — exercise only the seed-adapter stage for a series.
 * Skips LLM, voice, render, approval, upload. Useful for iterating on
 * seed-sourcing quality without cost or latency overhead.
 *
 * Usage:  node --import tsx scripts/yt-experiments/_test-seed-only.mjs briefing
 */
import { getSeedAdapter } from "./seed-adapters/index.mjs";
import { resolveOhwow } from "../x-experiments/_ohwow.mjs";

const slug = process.argv[2] || "briefing";
const { workspace } = resolveOhwow();

console.log(`[test-seed-only] slug=${slug} workspace=${workspace}`);
const pick = getSeedAdapter(slug);
const t0 = Date.now();
const seed = await pick({ workspace, historyDays: 5 });
const dt = ((Date.now() - t0) / 1000).toFixed(1);

if (!seed) {
  console.log(`[test-seed-only] ❌ no seed (dt=${dt}s)`);
  process.exit(1);
}

console.log(`\n[test-seed-only] ✅ seed returned in ${dt}s\n`);
console.log("KIND:     ", seed.kind);
console.log("TITLE:    ", seed.title);
console.log("CITATIONS:", seed.citations?.length ?? 0);
console.log("METADATA: ", JSON.stringify(seed.metadata, null, 2));
console.log("\nBODY:\n" + seed.body);
if (seed.citations?.length) {
  console.log("\nCITATION URLS:");
  for (const c of seed.citations.slice(0, 6)) {
    console.log(`  - ${c.handle ? "@" + c.handle + " " : ""}${c.url || ""}`);
    if (c.text) console.log(`    "${c.text.slice(0, 120)}"`);
  }
}
