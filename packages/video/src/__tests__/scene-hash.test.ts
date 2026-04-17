import { describe, it, expect } from "vitest";
import {
  hashScene,
  hashScenesInSpec,
  sceneAbsoluteRanges,
  audioRefsOverlappingScene,
  type SceneHashContext,
} from "../render/scene-hash";
import type { Scene, VideoSpec, BrandTokens } from "../spec/types";

const brand: BrandTokens = {
  colors: { primary: "#fff" },
  fonts: { sans: "Inter", mono: "JetBrains", display: "Inter" },
  glass: {
    background: "rgba(0,0,0,0.5)",
    border: "1px solid #fff",
    borderRadius: 12,
    backdropFilter: "blur(10px)",
  },
};

const ctx: SceneHashContext = {
  brand,
  fps: 30,
  width: 1920,
  height: 1080,
  overlappingVoiceovers: [],
};

const scene: Scene = {
  id: "s1",
  kind: "composable",
  durationInFrames: 120,
  params: { foo: 1, bar: 2 },
};

describe("hashScene", () => {
  it("returns a sha256 hex", () => {
    const h = hashScene(scene, ctx);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable under property-insertion order", () => {
    const a = hashScene(scene, ctx);
    const reordered: Scene = {
      durationInFrames: 120,
      id: "s1",
      kind: "composable",
      params: { bar: 2, foo: 1 },
    };
    const b = hashScene(reordered, ctx);
    expect(a).toBe(b);
  });

  it("changes when scene params change", () => {
    const a = hashScene(scene, ctx);
    const b = hashScene({ ...scene, params: { foo: 1, bar: 3 } }, ctx);
    expect(a).not.toBe(b);
  });

  it("changes when fps changes", () => {
    const a = hashScene(scene, ctx);
    const b = hashScene(scene, { ...ctx, fps: 60 });
    expect(a).not.toBe(b);
  });

  it("changes when width changes", () => {
    const a = hashScene(scene, ctx);
    const b = hashScene(scene, { ...ctx, width: 3840 });
    expect(a).not.toBe(b);
  });

  it("changes when palette changes", () => {
    const a = hashScene(scene, ctx);
    const b = hashScene(scene, {
      ...ctx,
      palette: { seedHue: 200, harmony: "analogous", mood: "midnight" },
    });
    expect(a).not.toBe(b);
  });

  it("changes when overlapping voiceover changes", () => {
    const a = hashScene(scene, ctx);
    const b = hashScene(scene, {
      ...ctx,
      overlappingVoiceovers: [{ src: "cache://x", startFrame: 0 }],
    });
    expect(a).not.toBe(b);
  });

  it("does NOT change when position in the broader spec shifts", () => {
    // Scene id + hash are the same regardless of which index it sits at;
    // absolute position is ctx-independent.
    const a = hashScene(scene, ctx);
    const b = hashScene({ ...scene }, ctx);
    expect(a).toBe(b);
  });
});

describe("sceneAbsoluteRanges", () => {
  it("returns [start, end) pairs summing to total duration (no transitions)", () => {
    const spec: VideoSpec = {
      id: "t",
      version: 1,
      fps: 30,
      width: 1920,
      height: 1080,
      brand,
      voiceovers: [],
      transitions: [],
      scenes: [
        { id: "a", kind: "composable", durationInFrames: 60 },
        { id: "b", kind: "composable", durationInFrames: 90 },
      ],
    };
    expect(sceneAbsoluteRanges(spec)).toEqual([
      { start: 0, end: 60 },
      { start: 60, end: 150 },
    ]);
  });

  it("accounts for transition overlap", () => {
    const spec: VideoSpec = {
      id: "t",
      version: 1,
      fps: 30,
      width: 1920,
      height: 1080,
      brand,
      voiceovers: [],
      transitions: [{ kind: "fade", durationInFrames: 10 }],
      scenes: [
        { id: "a", kind: "composable", durationInFrames: 60 },
        { id: "b", kind: "composable", durationInFrames: 90 },
      ],
    };
    // After scene 1 (60 frames), transition overlap of 10 pulls next start back.
    expect(sceneAbsoluteRanges(spec)).toEqual([
      { start: 0, end: 60 },
      { start: 50, end: 140 },
    ]);
  });
});

describe("audioRefsOverlappingScene", () => {
  it("returns refs whose range intersects the scene range", () => {
    const refs = [
      { src: "a", startFrame: 0, durationFrames: 30 },   // 0..30
      { src: "b", startFrame: 50, durationFrames: 40 },  // 50..90
      { src: "c", startFrame: 100, durationFrames: 20 }, // 100..120
    ];
    const hits = audioRefsOverlappingScene(refs, { start: 40, end: 100 });
    expect(hits.map(r => r.src)).toEqual(["b"]);
  });

  it("open-ended audio (no durationFrames) matches if it starts before the end", () => {
    const refs = [{ src: "long", startFrame: 0 }];
    const hits = audioRefsOverlappingScene(refs, { start: 500, end: 1000 });
    expect(hits.length).toBe(1);
  });
});

describe("hashScenesInSpec", () => {
  it("returns one entry per scene with stable order", () => {
    const spec: VideoSpec = {
      id: "t",
      version: 1,
      fps: 30,
      width: 1920,
      height: 1080,
      brand,
      voiceovers: [],
      transitions: [],
      scenes: [
        { id: "a", kind: "composable", durationInFrames: 60, params: { k: 1 } },
        { id: "b", kind: "composable", durationInFrames: 60, params: { k: 2 } },
      ],
    };
    const hashes = hashScenesInSpec(spec);
    expect(hashes.length).toBe(2);
    expect(hashes[0].sceneId).toBe("a");
    expect(hashes[1].sceneId).toBe("b");
    expect(hashes[0].hash).not.toBe(hashes[1].hash);
  });

  it("two scenes with identical shape produce identical hashes", () => {
    const spec: VideoSpec = {
      id: "t",
      version: 1,
      fps: 30,
      width: 1920,
      height: 1080,
      brand,
      voiceovers: [],
      transitions: [],
      scenes: [
        { id: "a", kind: "composable", durationInFrames: 60 },
        { id: "b", kind: "composable", durationInFrames: 60 },
      ],
    };
    const hashes = hashScenesInSpec(spec);
    expect(hashes[0].hash).toBe(hashes[1].hash);
  });

  it("voice on one scene changes only that scene's hash", () => {
    const spec: VideoSpec = {
      id: "t",
      version: 1,
      fps: 30,
      width: 1920,
      height: 1080,
      brand,
      voiceovers: [{ src: "cache://voice", startFrame: 10, durationFrames: 40 }],
      transitions: [],
      scenes: [
        { id: "a", kind: "composable", durationInFrames: 60 },
        { id: "b", kind: "composable", durationInFrames: 60 },
      ],
    };
    const hashes = hashScenesInSpec(spec);
    // Voice overlaps only scene[0] (0..60); scene[1] (60..120) has no voice.
    // Scene[1] should have the same hash as an unadorned spec.
    const unadornedSpec: VideoSpec = { ...spec, voiceovers: [] };
    const baseline = hashScenesInSpec(unadornedSpec);
    expect(hashes[1].hash).toBe(baseline[1].hash);
    expect(hashes[0].hash).not.toBe(baseline[0].hash);
  });
});
