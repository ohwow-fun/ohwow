import { describe, it, expect } from "vitest";
import {
  breathCycle,
  driftVector,
  chromeMaterialPreset,
  glassMaterialPreset,
  warmPalettePreset,
  MOTION_PROFILES,
  getMotionProfile,
} from "../asmr";

describe("asmr/breathCycle", () => {
  it("returns 0 at frame 0 (sin(0))", () => {
    expect(breathCycle(0, 180, 1)).toBeCloseTo(0, 5);
  });

  it("reaches +amp at a quarter-period", () => {
    expect(breathCycle(45, 180, 1)).toBeCloseTo(1, 5);
  });

  it("reaches -amp at three-quarter-period", () => {
    expect(breathCycle(135, 180, 1)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for zero period (guards against div by zero)", () => {
    expect(breathCycle(30, 0, 1)).toBe(0);
  });

  it("stays inside [-amp, +amp]", () => {
    for (let f = 0; f < 360; f += 7) {
      const v = breathCycle(f, 180, 0.25);
      expect(v).toBeGreaterThanOrEqual(-0.25 - 1e-9);
      expect(v).toBeLessThanOrEqual(0.25 + 1e-9);
    }
  });
});

describe("asmr/driftVector", () => {
  it("returns values in approximately [-1, 1]", () => {
    for (let f = 0; f < 600; f += 11) {
      const { x, y } = driftVector(f, 42, 0.005);
      expect(Math.abs(x)).toBeLessThanOrEqual(1.01);
      expect(Math.abs(y)).toBeLessThanOrEqual(1.01);
    }
  });

  it("is deterministic for same (frame, seed)", () => {
    const a = driftVector(100, 7, 0.003);
    const b = driftVector(100, 7, 0.003);
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
  });

  it("different seeds diverge", () => {
    const a = driftVector(100, 1, 0.003);
    const b = driftVector(100, 2, 0.003);
    expect(a.x === b.x && a.y === b.y).toBe(false);
  });
});

describe("asmr/material presets", () => {
  it("chrome has high metalness + low roughness", () => {
    expect(chromeMaterialPreset.metalness).toBeGreaterThan(0.7);
    expect(chromeMaterialPreset.roughness).toBeLessThan(0.3);
  });

  it("glass has transmission + ior set", () => {
    expect(glassMaterialPreset.transmission).toBeGreaterThan(0.8);
    expect(glassMaterialPreset.ior).toBeCloseTo(1.5, 1);
  });

  it("warm palette has highlight, mid, shadow, accent", () => {
    expect(warmPalettePreset).toHaveProperty("highlight");
    expect(warmPalettePreset).toHaveProperty("mid");
    expect(warmPalettePreset).toHaveProperty("shadow");
    expect(warmPalettePreset).toHaveProperty("accent");
  });
});

describe("asmr/MOTION_PROFILES", () => {
  it("has exactly the three expected profiles", () => {
    expect(Object.keys(MOTION_PROFILES).sort()).toEqual(["asmr", "chaotic", "crisp"]);
  });

  it("asmr is slower than crisp is slower than chaotic", () => {
    expect(MOTION_PROFILES.asmr.crossfadeFrames).toBeGreaterThan(MOTION_PROFILES.crisp.crossfadeFrames);
    expect(MOTION_PROFILES.crisp.crossfadeFrames).toBeGreaterThan(MOTION_PROFILES.chaotic.crossfadeFrames);
    expect(MOTION_PROFILES.asmr.backgroundDriftSpeed).toBeLessThan(MOTION_PROFILES.crisp.backgroundDriftSpeed);
    expect(MOTION_PROFILES.crisp.backgroundDriftSpeed).toBeLessThan(MOTION_PROFILES.chaotic.backgroundDriftSpeed);
  });

  it("only asmr has breath-cycle enabled", () => {
    expect(MOTION_PROFILES.asmr.breathAmp).toBeGreaterThan(0);
    expect(MOTION_PROFILES.crisp.breathAmp).toBe(0);
    expect(MOTION_PROFILES.chaotic.breathAmp).toBe(0);
  });
});

describe("asmr/getMotionProfile", () => {
  it("resolves known names", () => {
    expect(getMotionProfile("asmr")).toBe(MOTION_PROFILES.asmr);
    expect(getMotionProfile("crisp")).toBe(MOTION_PROFILES.crisp);
    expect(getMotionProfile("chaotic")).toBe(MOTION_PROFILES.chaotic);
  });

  it("defaults to asmr for unknown/missing", () => {
    expect(getMotionProfile("rainbow")).toBe(MOTION_PROFILES.asmr);
    expect(getMotionProfile(undefined)).toBe(MOTION_PROFILES.asmr);
  });
});
