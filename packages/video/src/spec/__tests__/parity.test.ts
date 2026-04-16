import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { totalDurationFrames } from "../totalDuration";
import type { VideoSpec } from "../types";

describe("parity: ohwow-demo", () => {
  const spec = JSON.parse(
    readFileSync(resolve(__dirname, "../../../specs/ohwow-demo.json"), "utf8"),
  ) as VideoSpec;

  it("has 5 scenes with expected durations", () => {
    expect(spec.scenes.map((s) => s.durationInFrames)).toEqual([380, 120, 330, 315, 280]);
  });

  it("has 4 transitions of 20 frames each", () => {
    expect(spec.transitions).toHaveLength(4);
    for (const t of spec.transitions) {
      expect(t.kind).toBe("fade");
      if (t.kind === "fade") expect(t.durationInFrames).toBe(20);
    }
  });

  it("has voiceover start frames matching OhwowDemo.tsx (5/370/470/780/1075)", () => {
    expect(spec.voiceovers.map((v) => v.startFrame)).toEqual([5, 370, 470, 780, 1075]);
  });

  it("total duration resolves to 1345 frames (45s @ 30fps)", () => {
    expect(totalDurationFrames(spec)).toBe(1345);
  });

  it("scene kinds map to the five v1 registry entries in order", () => {
    expect(spec.scenes.map((s) => s.kind)).toEqual([
      "prompts-grid",
      "drop",
      "extraction",
      "outcome-orbit",
      "cta-mesh",
    ]);
  });
});
