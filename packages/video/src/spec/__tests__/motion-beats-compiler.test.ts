import { describe, it, expect } from "vitest";
import { compileSceneBeats, compileSpecBeats } from "../motion-beats-compiler";
import type { Scene } from "../types";

describe("motion-beats-compiler/compileSceneBeats", () => {
  it("passes scenes without beats through unchanged", () => {
    const scene: Scene = {
      id: "s1",
      kind: "composable",
      durationInFrames: 60,
      params: { visualLayers: [{ primitive: "aurora", params: {} }] },
    };
    const { scene: out, report } = compileSceneBeats(scene);
    expect(report.applied).toBe(false);
    expect(out).toEqual(scene);
  });

  it("skips scenes whose kind is a custom-* codegen output", () => {
    const scene: Scene = {
      id: "s-codegen",
      kind: "custom-briefing-story-2a",
      durationInFrames: 120,
      motion_beats: [
        { primitive: "r3f.count-up-bar", params: { target: 13 } },
      ],
    };
    const { scene: out, report } = compileSceneBeats(scene);
    expect(report.applied).toBe(false);
    expect(report.note).toMatch(/codegen kind/);
    expect(out).toEqual(scene);
  });

  it("compiles all-2D beats into visualLayers + chooses composable kind", () => {
    const scene: Scene = {
      id: "s2",
      kind: "unspecified",
      durationInFrames: 120,
      motion_beats: [
        { primitive: "grid-morph", params: { cols: 16 } },
        { primitive: "count-up", params: { target: 13, unit: "%" } },
      ],
    };
    const { scene: out, report } = compileSceneBeats(scene);
    expect(report.applied).toBe(true);
    expect(report.chosenKind).toBe("composable");
    expect(out.kind).toBe("composable");
    expect((out.params as Record<string, unknown>).visualLayers).toEqual([
      { primitive: "grid-morph", params: { cols: 16 } },
      { primitive: "count-up", params: { target: 13, unit: "%" } },
    ]);
  });

  it("compiles all-R3F beats into primitives + chooses r3f-scene kind", () => {
    const scene: Scene = {
      id: "s3",
      kind: "unspecified",
      durationInFrames: 150,
      motion_beats: [
        { primitive: "r3f.particle-cloud", params: { count: 500 } },
        { primitive: "r3f.count-up-bar", params: { target: 93 } },
      ],
    };
    const { scene: out, report } = compileSceneBeats(scene);
    expect(report.applied).toBe(true);
    expect(report.chosenKind).toBe("r3f-scene");
    expect(out.kind).toBe("r3f-scene");
    expect((out.params as Record<string, unknown>).primitives).toEqual([
      { primitive: "r3f.particle-cloud", params: { count: 500 } },
      { primitive: "r3f.count-up-bar", params: { target: 93 } },
    ]);
  });

  it("preserves existing scene-level params like camera + background", () => {
    const scene: Scene = {
      id: "s4",
      kind: "unspecified",
      durationInFrames: 150,
      params: {
        background: "#0a1020",
        environmentPreset: "sunset",
        camera: { position: [0, 0, 8], fov: 45 },
        motionProfile: "asmr",
      },
      motion_beats: [{ primitive: "r3f.count-up-bar", params: { target: 13 } }],
    };
    const { scene: out } = compileSceneBeats(scene);
    const p = out.params as Record<string, unknown>;
    expect(p.background).toBe("#0a1020");
    expect(p.environmentPreset).toBe("sunset");
    expect(p.motionProfile).toBe("asmr");
    expect(p.camera).toEqual({ position: [0, 0, 8], fov: 45 });
    expect((p.primitives as Array<unknown>).length).toBe(1);
  });

  it("drops 2D beats when any R3F beat is present (mixed namespaces unsupported in v1)", () => {
    const scene: Scene = {
      id: "s5",
      kind: "unspecified",
      durationInFrames: 150,
      motion_beats: [
        { primitive: "r3f.count-up-bar", params: { target: 42 } },
        { primitive: "grid-morph", params: {} }, // will be dropped
        { primitive: "badge-reveal", params: {} }, // will be dropped
      ],
    };
    const { scene: out, report } = compileSceneBeats(scene);
    expect(report.chosenKind).toBe("r3f-scene");
    expect(report.droppedBeats?.length).toBe(2);
    expect(report.droppedBeats?.map((d) => d.primitive).sort()).toEqual([
      "badge-reveal",
      "grid-morph",
    ]);
    expect((out.params as Record<string, unknown>).primitives).toHaveLength(1);
    expect((out.params as Record<string, unknown>).visualLayers).toBeUndefined();
  });

  it("merges beats with any pre-existing primitives[] or visualLayers[]", () => {
    const scene: Scene = {
      id: "s6",
      kind: "r3f-scene",
      durationInFrames: 150,
      params: {
        primitives: [{ primitive: "r3f.particle-cloud", params: { count: 400 } }],
      },
      motion_beats: [{ primitive: "r3f.count-up-bar", params: { target: 13 } }],
    };
    const { scene: out } = compileSceneBeats(scene);
    const prims = (out.params as Record<string, unknown>).primitives as Array<{ primitive: string }>;
    expect(prims.length).toBe(2);
    expect(prims[0].primitive).toBe("r3f.particle-cloud");
    expect(prims[1].primitive).toBe("r3f.count-up-bar");
  });

  it("preserves narration, motion_graphic_prompt, and motion_beats on the compiled scene", () => {
    const scene: Scene = {
      id: "s7",
      kind: "unspecified",
      durationInFrames: 120,
      narration: "Opus 4.7 ships with a 13 percent lift.",
      motion_graphic_prompt: "Show a chrome count-up bar to 13%",
      motion_beats: [{ primitive: "r3f.count-up-bar", params: { target: 13, unit: "%" } }],
    };
    const { scene: out } = compileSceneBeats(scene);
    expect(out.narration).toBe(scene.narration);
    expect(out.motion_graphic_prompt).toBe(scene.motion_graphic_prompt);
    expect(out.motion_beats).toEqual(scene.motion_beats);
  });
});

describe("motion-beats-compiler/compileSpecBeats", () => {
  it("compiles every scene and returns per-scene reports", () => {
    const scenes: Scene[] = [
      { id: "a", kind: "composable", durationInFrames: 60 },
      {
        id: "b",
        kind: "unspecified",
        durationInFrames: 90,
        motion_beats: [{ primitive: "r3f.count-up-bar", params: { target: 10 } }],
      },
    ];
    const { scenes: out, reports } = compileSpecBeats(scenes);
    expect(out.length).toBe(2);
    expect(out[0].kind).toBe("composable"); // unchanged
    expect(out[1].kind).toBe("r3f-scene"); // compiled
    expect(reports[0].applied).toBe(false);
    expect(reports[1].applied).toBe(true);
    expect(reports[1].chosenKind).toBe("r3f-scene");
  });

  it("doesn't mutate the input scenes array", () => {
    const scenes: Scene[] = [
      {
        id: "a",
        kind: "unspecified",
        durationInFrames: 60,
        motion_beats: [{ primitive: "count-up", params: { target: 50 } }],
      },
    ];
    const originalKind = scenes[0].kind;
    compileSpecBeats(scenes);
    expect(scenes[0].kind).toBe(originalKind);
  });
});
