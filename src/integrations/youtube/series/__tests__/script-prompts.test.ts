import { describe, it, expect } from "vitest";
import { getPromptModule, hasPromptModule } from "../script-prompts/index.js";
import type { SeriesSeed } from "../script-prompts/types.js";
import { SERIES, listSeries } from "../registry.js";

const V1_SLUGS = ["briefing", "tomorrow-broke", "mind-wars", "operator-mode"] as const;

describe("series/script-prompts", () => {
  it("has a prompt module for every enabled series", () => {
    for (const s of listSeries({ onlyEnabled: true })) {
      expect(hasPromptModule(s.slug)).toBe(true);
    }
  });

  it("does NOT have a prompt module for disabled series (bot-beats)", () => {
    expect(hasPromptModule("bot-beats")).toBe(false);
    expect(() => getPromptModule("bot-beats")).toThrow(/deferred|missing/);
  });

  it.each(V1_SLUGS)("%s prompt module has shape + substance", (slug) => {
    const mod = getPromptModule(slug);
    expect(mod.slug).toBe(slug);
    expect(mod.systemPrompt.length).toBeGreaterThan(600);
    expect(mod.bannedPhrases.length).toBeGreaterThan(0);
    expect(typeof mod.buildUserPrompt).toBe("function");
  });

  it.each(V1_SLUGS)("%s banned list lowercases every entry", (slug) => {
    const mod = getPromptModule(slug);
    for (const p of mod.bannedPhrases) {
      expect(p).toBe(p.toLowerCase());
    }
  });

  it.each(V1_SLUGS)("%s buildUserPrompt includes seed title + body", (slug) => {
    const mod = getPromptModule(slug);
    const seed: SeriesSeed = {
      kind: "x-intel",
      title: "TEST_TITLE_SENTINEL",
      body: "TEST_BODY_SENTINEL",
    };
    const out = mod.buildUserPrompt(seed);
    expect(out).toContain("TEST_TITLE_SENTINEL");
    expect(out).toContain("TEST_BODY_SENTINEL");
  });

  it("each prompt has OUTPUT STRICT JSON block so the LLM returns parseable output", () => {
    for (const slug of V1_SLUGS) {
      const mod = getPromptModule(slug);
      expect(mod.systemPrompt).toMatch(/OUTPUT STRICT JSON/);
    }
  });

  it("each prompt defines a SELF-CHECK block so models catch their own failures", () => {
    for (const slug of V1_SLUGS) {
      const mod = getPromptModule(slug);
      expect(mod.systemPrompt).toMatch(/SELF-CHECK/);
    }
  });

  it("series-level confidence floors are reasonable (0.4-0.7 band)", () => {
    for (const slug of V1_SLUGS) {
      const mod = getPromptModule(slug);
      const floor = mod.confidenceFloor ?? 0.4;
      expect(floor).toBeGreaterThanOrEqual(0.4);
      expect(floor).toBeLessThanOrEqual(0.7);
    }
  });

  it("all four v1 series carry series-specific banned phrases (no shared base)", () => {
    const sets = V1_SLUGS.map((s) => new Set(getPromptModule(s).bannedPhrases));
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const overlap = [...sets[i]].filter((x) => sets[j].has(x));
        // A tiny bit of overlap is fine (both Briefing + Operator Mode ban
        // "game-changer") — but NO two series should share >50% of their lists.
        const smaller = Math.min(sets[i].size, sets[j].size);
        expect(overlap.length / smaller).toBeLessThan(0.5);
      }
    }
  });

  it("registry and prompt modules agree on which series are enabled", () => {
    for (const slug of Object.keys(SERIES) as Array<keyof typeof SERIES>) {
      const enabled = SERIES[slug].enabled;
      expect(hasPromptModule(slug)).toBe(enabled);
    }
  });
});
