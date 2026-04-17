import { describe, it, expect } from "vitest";
import {
  VideoSpecSchema,
  parseVideoSpec,
  safeParseVideoSpec,
} from "../spec/schema";
import type { VideoSpec } from "../spec/types";

const validSpec: VideoSpec = {
  id: "test",
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
    {
      id: "s1",
      kind: "composable",
      durationInFrames: 120,
    },
  ],
};

describe("VideoSpecSchema", () => {
  it("accepts a minimal valid spec", () => {
    const result = VideoSpecSchema.safeParse(validSpec);
    expect(result.success).toBe(true);
  });

  it("rejects version != 1", () => {
    const bad = { ...validSpec, version: 2 };
    expect(VideoSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects empty scenes array", () => {
    const bad = { ...validSpec, scenes: [] };
    expect(VideoSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-integer fps", () => {
    const bad = { ...validSpec, fps: 29.97 };
    expect(VideoSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects scene with non-positive duration", () => {
    const bad = {
      ...validSpec,
      scenes: [{ id: "s1", kind: "x", durationInFrames: 0 }],
    };
    expect(VideoSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts custom scene kinds (open set)", () => {
    const spec = {
      ...validSpec,
      scenes: [{ id: "s1", kind: "my-custom-kind", durationInFrames: 60 }],
    };
    expect(VideoSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("accepts custom transition kinds (open set)", () => {
    const spec = {
      ...validSpec,
      transitions: [{ kind: "shader-dissolve", durationInFrames: 15 }],
    };
    expect(VideoSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("accepts AudioRef with cache:// src", () => {
    const spec = {
      ...validSpec,
      voiceovers: [{ src: "cache://abc123", startFrame: 0 }],
    };
    expect(VideoSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("rejects AudioRef with empty src", () => {
    const spec = {
      ...validSpec,
      voiceovers: [{ src: "", startFrame: 0 }],
    };
    expect(VideoSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects palette with seedHue >= 360", () => {
    const spec = {
      ...validSpec,
      palette: { seedHue: 360, harmony: "analogous", mood: "dark" },
    };
    expect(VideoSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("accepts scene metadata.voiceDurationMs", () => {
    const spec = {
      ...validSpec,
      scenes: [
        {
          id: "s1",
          kind: "composable",
          durationInFrames: 120,
          metadata: { voiceDurationMs: 3500 },
        },
      ],
    };
    expect(VideoSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("parseVideoSpec throws on invalid input", () => {
    expect(() => parseVideoSpec({ nope: true })).toThrow();
  });

  it("safeParseVideoSpec returns ok:true for valid", () => {
    const result = safeParseVideoSpec(validSpec);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.id).toBe("test");
  });

  it("safeParseVideoSpec returns ok:false with issues for invalid", () => {
    const result = safeParseVideoSpec({ nope: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });
});
