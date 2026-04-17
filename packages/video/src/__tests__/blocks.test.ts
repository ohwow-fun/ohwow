import { describe, it, expect } from "vitest";
import { BLOCKS, getBlock, listBlocks } from "../blocks/catalog";
import { lintVideoSpec } from "../spec/lint";
import type { VideoSpec } from "../spec/types";

const shellSpec: Omit<VideoSpec, "scenes"> = {
  id: "blocks-test",
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
};

describe("blocks catalog", () => {
  it("ships exactly 8 built-in blocks", () => {
    expect(BLOCKS.length).toBe(8);
  });

  it("every block has a unique id", () => {
    const ids = BLOCKS.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every block has a non-empty description and name", () => {
    for (const b of BLOCKS) {
      expect(b.name.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(10);
    }
  });

  it("getBlock returns the block or undefined", () => {
    expect(getBlock("title-card")?.id).toBe("title-card");
    expect(getBlock("nope")).toBeUndefined();
  });

  it("listBlocks filters by category", () => {
    const metrics = listBlocks("metrics");
    expect(metrics.every(b => b.category === "metrics")).toBe(true);
    expect(metrics.length).toBe(2); // stat-card + metric-dashboard
  });

  it("every block.build() with minimal params produces a spec that lints clean", () => {
    const sampleParams: Record<string, Record<string, unknown>> = {
      "title-card": { title: "Hello" },
      "lower-third": { name: "Jesus Onoro" },
      "caption-strip": { text: "A short caption." },
      "quote-card": { quote: "Time is the scarcest resource." },
      "bullet-list": { items: ["First", "Second", "Third"] },
      "stat-card": { value: "42", label: "users" },
      "metric-dashboard": {
        metrics: [
          { value: "99%", label: "uptime" },
          { value: "2.3s", label: "p95" },
          { value: "0", label: "incidents" },
        ],
      },
      "logo-reveal": { wordmark: "ohwow" },
    };

    for (const block of BLOCKS) {
      const params = sampleParams[block.id];
      if (!params) throw new Error(`No sample params for block ${block.id}`);
      const scene = block.build(params);
      const spec: VideoSpec = {
        ...shellSpec,
        scenes: [{ id: `test-${block.id}`, ...scene }],
      };
      const result = lintVideoSpec(spec);
      if (!result.ok || result.warnings.length > 0) {
        const issues = [...result.errors, ...result.warnings];
        throw new Error(
          `Block "${block.id}" produced a spec with issues:\n${issues.map(i => `  ${i.code}  ${i.path}  ${i.message}`).join("\n")}`,
        );
      }
      expect(result.ok).toBe(true);
    }
  });

  it("block params produce stable output (deterministic)", () => {
    const block = getBlock("stat-card");
    const a = block?.build({ value: "42", label: "x" });
    const b = block?.build({ value: "42", label: "x" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("strictParams lint passes for every block (whitelisted params)", () => {
    const sampleParams: Record<string, Record<string, unknown>> = {
      "title-card": { title: "X" },
      "lower-third": { name: "X" },
      "caption-strip": { text: "X" },
      "quote-card": { quote: "X" },
      "bullet-list": { items: ["X"] },
      "stat-card": { value: "1", label: "x" },
      "metric-dashboard": { metrics: [{ value: "1", label: "x" }] },
      "logo-reveal": { wordmark: "X" },
    };
    for (const block of BLOCKS) {
      const scene = block.build(sampleParams[block.id]);
      const spec: VideoSpec = {
        ...shellSpec,
        scenes: [{ id: `strict-${block.id}`, ...scene }],
      };
      const result = lintVideoSpec(spec, { strictParams: true });
      if (!result.ok) {
        throw new Error(
          `Block "${block.id}" fails strict lint:\n${result.errors.map(e => `  ${e.code}  ${e.path}  ${e.message}`).join("\n")}`,
        );
      }
    }
  });
});
