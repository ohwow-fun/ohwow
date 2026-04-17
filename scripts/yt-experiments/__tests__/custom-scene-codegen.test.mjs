/**
 * Tests for the Phase 3 codegen validator. We exercise the static
 * validation paths (allowlist, denylist, syntax) without hitting the
 * LLM — that path is stubbed by driving the validator + file writer
 * directly via writeCustomSceneFromSource.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  validateCodegen,
  validateSyntax,
  extractImportSources,
  resetGenerated,
  writeCustomSceneFromSource,
} from "../_custom-scene-codegen.mjs";

const GEN_DIR = path.resolve("packages/video/src/scenes/.generated");
const BARREL = path.join(GEN_DIR, "index.ts");

const VALID_TSX = `import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";

const CustomScene: React.FC<{ params?: Record<string, unknown>; durationInFrames?: number }> = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], { easing: Easing.inOut(Easing.cubic) });
  return <div style={{ opacity }}>hello</div>;
};

export default CustomScene;
`;

describe("extractImportSources", () => {
  it("pulls out import sources with default + named imports", () => {
    const src = `
import React from "react";
import { foo, bar } from "remotion";
import * as THREE from "three";
import "@react-three/drei";
`;
    const sources = extractImportSources(src);
    expect(sources).toEqual(["react", "remotion", "three", "@react-three/drei"]);
  });

  it("ignores non-import strings that look like imports", () => {
    const src = `const s = "import x from 'fs'";`;
    expect(extractImportSources(src)).toEqual([]);
  });
});

describe("validateCodegen", () => {
  it("accepts a clean allowlisted scene", () => {
    const r = validateCodegen(VALID_TSX);
    expect(r.ok).toBe(true);
  });

  it("rejects a banned node-core import", () => {
    const src = VALID_TSX.replace(
      'import React from "react";',
      'import React from "react";\nimport fs from "fs";',
    );
    const r = validateCodegen(src);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fs/);
  });

  it("rejects a relative import", () => {
    const src = VALID_TSX.replace(
      'import React from "react";',
      'import React from "react";\nimport x from "../registry";',
    );
    const r = validateCodegen(src);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/relative/);
  });

  it("rejects arbitrary npm package", () => {
    const src = VALID_TSX.replace(
      'import React from "react";',
      'import React from "react";\nimport axios from "axios";',
    );
    const r = validateCodegen(src);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/allowlist/);
  });

  it("rejects eval()", () => {
    const src = VALID_TSX.replace(
      "const opacity",
      'const payload = eval("1+1");\n  const opacity',
    );
    const r = validateCodegen(src);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/eval/);
  });

  it("rejects new Function()", () => {
    const src = VALID_TSX.replace(
      "const opacity",
      'const f = new Function("return 1");\n  const opacity',
    );
    const r = validateCodegen(src);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Function/);
  });

  it("rejects dynamic import()", () => {
    const src = VALID_TSX.replace(
      "const opacity",
      'const mod = import("remotion");\n  const opacity',
    );
    const r = validateCodegen(src);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/dynamic import/);
  });

  it("rejects process.env access", () => {
    const src = VALID_TSX.replace(
      "const opacity",
      'const env = process.env.SECRET;\n  const opacity',
    );
    const r = validateCodegen(src);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/process/);
  });

  it("rejects fetch()", () => {
    const src = VALID_TSX.replace(
      "const opacity",
      'const p = fetch("https://x.com");\n  const opacity',
    );
    const r = validateCodegen(src);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fetch/);
  });

  it("rejects a file without a default export", () => {
    const src = VALID_TSX.replace("export default CustomScene;", "export { CustomScene };");
    const r = validateCodegen(src);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/default/);
  });

  it("rejects an empty string", () => {
    const r = validateCodegen("");
    expect(r.ok).toBe(false);
  });
});

describe("validateSyntax", () => {
  it("accepts syntactically valid TSX", async () => {
    const r = await validateSyntax(VALID_TSX);
    expect(r.ok).toBe(true);
  });

  it("rejects garbage", async () => {
    const r = await validateSyntax("this is not tsx {{{{ <<<<<");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/syntax/);
  });
});

describe("resetGenerated + writeCustomSceneFromSource", () => {
  beforeEach(() => {
    resetGenerated();
  });

  it("resets the .generated dir to an empty barrel", () => {
    const barrel = fs.readFileSync(BARREL, "utf8");
    expect(barrel).toMatch(/GENERATED_SCENES/);
    expect(barrel).not.toMatch(/^import Scene_/m);
  });

  it("writes a validated scene and adds it to the barrel", async () => {
    const r = await writeCustomSceneFromSource({
      episodeId: "test-episode",
      sceneId: "scene-a",
      tsx: VALID_TSX,
    });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("custom-test-episode-scene-a");
    const written = fs.readFileSync(path.join(GEN_DIR, "test-episode-scene-a.tsx"), "utf8");
    expect(written).toBe(VALID_TSX);
    const barrel = fs.readFileSync(BARREL, "utf8");
    expect(barrel).toMatch(/import Scene_test_episode_scene_a from "\.\/test-episode-scene-a"/);
    expect(barrel).toMatch(/"custom-test-episode-scene-a": Scene_test_episode_scene_a/);
  });

  it("rejects invalid TSX without touching the filesystem", async () => {
    const bad = VALID_TSX.replace(
      'import React from "react";',
      'import React from "react";\nimport fs from "fs";',
    );
    const r = await writeCustomSceneFromSource({
      episodeId: "test-episode",
      sceneId: "scene-b",
      tsx: bad,
    });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(GEN_DIR, "test-episode-scene-b.tsx"))).toBe(false);
  });

  it("replaces an existing scene with the same slug idempotently", async () => {
    const first = await writeCustomSceneFromSource({
      episodeId: "ep",
      sceneId: "s",
      tsx: VALID_TSX,
    });
    expect(first.ok).toBe(true);
    const second = await writeCustomSceneFromSource({
      episodeId: "ep",
      sceneId: "s",
      tsx: VALID_TSX.replace("hello", "world"),
    });
    expect(second.ok).toBe(true);
    const barrel = fs.readFileSync(BARREL, "utf8");
    const importMatches = barrel.match(/import Scene_ep_s /g) || [];
    expect(importMatches.length).toBe(1);
    const src = fs.readFileSync(path.join(GEN_DIR, "ep-s.tsx"), "utf8");
    expect(src).toMatch(/world/);
  });
});

describe("resetGenerated cleanup", () => {
  it("removes TSX files from prior passes", async () => {
    resetGenerated();
    await writeCustomSceneFromSource({
      episodeId: "stale",
      sceneId: "scene",
      tsx: VALID_TSX,
    });
    expect(fs.existsSync(path.join(GEN_DIR, "stale-scene.tsx"))).toBe(true);
    resetGenerated();
    expect(fs.existsSync(path.join(GEN_DIR, "stale-scene.tsx"))).toBe(false);
    const barrel = fs.readFileSync(BARREL, "utf8");
    expect(barrel).not.toMatch(/stale-scene/);
  });
});
