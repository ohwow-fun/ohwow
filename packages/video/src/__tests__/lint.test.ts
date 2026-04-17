import { describe, it, expect } from "vitest";
import { lintVideoSpec } from "../spec/lint";
import type { VideoSpec } from "../spec/types";

const baseSpec: VideoSpec = {
  id: "lint-test",
  version: 1,
  fps: 30,
  width: 1920,
  height: 1080,
  brand: {
    colors: { primary: "#fff" },
    fonts: { sans: "Inter", mono: "JetBrains", display: "Inter" },
    glass: {
      background: "rgba(0,0,0,0.5)",
      border: "1px solid #fff",
      borderRadius: 12,
      backdropFilter: "blur(10px)",
    },
  },
  voiceovers: [],
  transitions: [],
  scenes: [
    { id: "s1", kind: "composable", durationInFrames: 120 },
    { id: "s2", kind: "composable", durationInFrames: 120 },
  ],
};

describe("lintVideoSpec", () => {
  it("passes on a clean spec", () => {
    const result = lintVideoSpec(baseSpec);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails Zod parse before semantic checks", () => {
    const result = lintVideoSpec({ not: "a spec" });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].code.startsWith("schema/")).toBe(true);
  });

  it("errors on unknown scene kind", () => {
    const spec = {
      ...baseSpec,
      scenes: [{ id: "s1", kind: "no-such-kind", durationInFrames: 120 }],
    };
    const result = lintVideoSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.code === "scene/unknown-kind")).toBe(true);
  });

  it("errors when scene is shorter than voiceover metadata", () => {
    const spec = {
      ...baseSpec,
      scenes: [
        {
          id: "s1",
          kind: "composable",
          durationInFrames: 30, // 1 second at fps=30
          metadata: { voiceDurationMs: 2000 }, // 2s of voice
        },
        { id: "s2", kind: "composable", durationInFrames: 60 },
      ],
    };
    const result = lintVideoSpec(spec);
    expect(result.errors.some(e => e.code === "scene/duration-shorter-than-voice")).toBe(true);
  });

  it("warns on tight padding between scene and voice", () => {
    const spec = {
      ...baseSpec,
      scenes: [
        {
          id: "s1",
          kind: "composable",
          durationInFrames: 62, // just barely over 60 frames needed
          metadata: { voiceDurationMs: 2000 }, // 60 frames at fps=30
        },
        { id: "s2", kind: "composable", durationInFrames: 60 },
      ],
    };
    const result = lintVideoSpec(spec);
    expect(result.warnings.some(w => w.code === "scene/tight-voice-padding")).toBe(true);
  });

  it("warns when narration has no voiceDurationMs", () => {
    const spec = {
      ...baseSpec,
      scenes: [
        { id: "s1", kind: "composable", durationInFrames: 120, narration: "Hello world." },
        { id: "s2", kind: "composable", durationInFrames: 60 },
      ],
    };
    const result = lintVideoSpec(spec);
    expect(result.warnings.some(w => w.code === "scene/narration-without-voice-duration")).toBe(true);
  });

  it("errors on caption extending past scene end", () => {
    const spec = {
      ...baseSpec,
      scenes: [
        {
          id: "s1",
          kind: "composable",
          durationInFrames: 60,
          captions: [{ text: "x", startFrame: 50, durationFrames: 30 }],
        },
        { id: "s2", kind: "composable", durationInFrames: 60 },
      ],
    };
    const result = lintVideoSpec(spec);
    expect(result.errors.some(e => e.code === "caption/out-of-bounds")).toBe(true);
  });

  it("errors on unknown layer primitive in composable visualLayers", () => {
    const spec = {
      ...baseSpec,
      scenes: [
        {
          id: "s1",
          kind: "composable",
          durationInFrames: 120,
          params: {
            visualLayers: [{ primitive: "no-such-primitive", params: {} }],
          },
        },
        { id: "s2", kind: "composable", durationInFrames: 60 },
      ],
    };
    const result = lintVideoSpec(spec);
    expect(result.errors.some(e => e.code === "layer/unknown-primitive")).toBe(true);
  });

  it("also checks legacy 'layers' key as a fallback", () => {
    const spec = {
      ...baseSpec,
      scenes: [
        {
          id: "s1",
          kind: "composable",
          durationInFrames: 120,
          params: {
            layers: [{ primitive: "no-such-primitive", params: {} }],
          },
        },
        { id: "s2", kind: "composable", durationInFrames: 60 },
      ],
    };
    const result = lintVideoSpec(spec);
    expect(result.errors.some(e => e.code === "layer/unknown-primitive")).toBe(true);
  });

  it("warns on unknown layer param by default; errors with strictParams", () => {
    const spec = {
      ...baseSpec,
      scenes: [
        {
          id: "s1",
          kind: "composable",
          durationInFrames: 120,
          params: {
            visualLayers: [{ primitive: "aurora", params: { bogusKey: 123 } }],
          },
        },
        { id: "s2", kind: "composable", durationInFrames: 60 },
      ],
    };
    const lenient = lintVideoSpec(spec);
    expect(lenient.warnings.some(w => w.code === "layer/unknown-param")).toBe(true);
    expect(lenient.ok).toBe(true);

    const strict = lintVideoSpec(spec, { strictParams: true });
    expect(strict.errors.some(e => e.code === "layer/unknown-param")).toBe(true);
    expect(strict.ok).toBe(false);
  });

  it("errors on unknown transition kind", () => {
    const spec = {
      ...baseSpec,
      transitions: [{ kind: "no-such-transition", durationInFrames: 15 }],
    };
    const result = lintVideoSpec(spec);
    expect(result.errors.some(e => e.code === "transition/unknown-kind")).toBe(true);
  });

  it("errors when transition overlap is too long vs adjacent scenes", () => {
    const spec = {
      ...baseSpec,
      scenes: [
        { id: "s1", kind: "composable", durationInFrames: 30 },
        { id: "s2", kind: "composable", durationInFrames: 30 },
      ],
      transitions: [{ kind: "fade", durationInFrames: 20 }], // 2*20 = 40 > 30
    };
    const result = lintVideoSpec(spec);
    expect(result.errors.some(e => e.code === "transition/overlap-too-long")).toBe(true);
  });

  it("errors on fade transition without durationInFrames", () => {
    const spec = {
      ...baseSpec,
      transitions: [{ kind: "fade" }], // missing duration
    };
    const result = lintVideoSpec(spec);
    expect(result.errors.some(e => e.code === "transition/missing-duration")).toBe(true);
  });

  it("warns on extra transitions beyond scene count", () => {
    const spec = {
      ...baseSpec,
      transitions: [
        { kind: "fade", durationInFrames: 15 },
        { kind: "fade", durationInFrames: 15 },
      ],
    };
    const result = lintVideoSpec(spec);
    expect(result.warnings.some(w => w.code === "transition/extra-entries")).toBe(true);
  });

  it("errors on odd dimensions", () => {
    const spec = { ...baseSpec, width: 1921 };
    const result = lintVideoSpec(spec);
    expect(result.errors.some(e => e.code === "dimensions/odd")).toBe(true);
  });

  it("warns on unusually low fps", () => {
    const spec = { ...baseSpec, fps: 10 };
    const result = lintVideoSpec(spec);
    expect(result.warnings.some(w => w.code === "fps/too-low")).toBe(true);
  });

  it("errors when voiceover starts past composition end", () => {
    const spec = {
      ...baseSpec,
      voiceovers: [{ src: "cache://abc", startFrame: 9999 }],
    };
    const result = lintVideoSpec(spec);
    expect(result.errors.some(e => e.code === "audio/voice-start-after-end")).toBe(true);
  });
});
