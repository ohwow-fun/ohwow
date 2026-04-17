import { describe, it, expect } from "vitest";
import {
  loadBrandKit,
  listBrandKitSlugs,
  brandKitPath,
} from "../index";
import fs from "node:fs";

const EXPECTED_SLUGS = [
  "bot-beats",
  "briefing",
  "mind-wars",
  "operator-mode",
  "tomorrow-broke",
];

describe("brand-kits", () => {
  it("ships five kits, one per canonical series", () => {
    expect(listBrandKitSlugs()).toEqual(EXPECTED_SLUGS);
  });

  it("every kit file lives at the path the loader expects", () => {
    for (const slug of EXPECTED_SLUGS) {
      expect(fs.existsSync(brandKitPath(slug))).toBe(true);
    }
  });

  it("every kit loads and keeps its slug consistent", () => {
    for (const slug of EXPECTED_SLUGS) {
      const kit = loadBrandKit(slug);
      expect(kit.slug).toBe(slug);
      expect(kit.displayName.length).toBeGreaterThan(0);
      expect(Object.keys(kit.colors).length).toBeGreaterThanOrEqual(4);
      expect(kit.fonts.sans).toBeTruthy();
      expect(kit.fonts.mono).toBeTruthy();
      expect(kit.fonts.display).toBeTruthy();
      expect(kit.primitivePalette.length).toBeGreaterThan(0);
      expect(["analogous", "complementary", "triadic", "split"]).toContain(
        kit.paletteHarmony,
      );
      expect(kit.paletteHue).toBeGreaterThanOrEqual(0);
      expect(kit.paletteHue).toBeLessThanOrEqual(360);
    }
  });

  it("loadBrandKit rejects an unknown slug", () => {
    expect(() => loadBrandKit("not-a-show")).toThrow(/brand kit not found/);
  });

  it("kits carry distinct visual identities (no accidental copy-paste)", () => {
    const kits = EXPECTED_SLUGS.map(loadBrandKit);
    const bgs = new Set(kits.map((k) => k.colors.bg));
    const accents = new Set(kits.map((k) => k.colors.accent));
    const hues = new Set(kits.map((k) => k.paletteHue));
    expect(bgs.size).toBe(kits.length);
    expect(accents.size).toBe(kits.length);
    expect(hues.size).toBe(kits.length);
  });

  it("every kit declares an ambient-mood default that maps to an ambient track", () => {
    const validMoods = new Set([
      "contemplative",
      "electric",
      "warm",
      "cosmic",
      "ethereal",
      "noir",
      "dawn",
    ]);
    for (const slug of EXPECTED_SLUGS) {
      const kit = loadBrandKit(slug);
      expect(validMoods.has(kit.ambientMoodDefault)).toBe(true);
    }
  });
});
