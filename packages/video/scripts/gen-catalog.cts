/**
 * Emit packages/video/dist/catalog.json — a machine-readable catalog of every
 * registered primitive, scene kind, transition, and block. Agents read it to
 * avoid guessing the API surface.
 *
 * Run via `npm run gen:catalog` in packages/video, or `npx tsx packages/video/scripts/gen-catalog.cts`.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { listLayerPrimitives } from "../src/layers/registry";
import { listSceneKinds } from "../src/scenes/registry";
import { listTransitions } from "../src/transitions/registry";
import { BLOCKS } from "../src/blocks/catalog";

interface Catalog {
  generatedAt: string;
  version: 1;
  primitives: Array<{
    name: string;
    builtin: boolean;
    params: readonly string[];
    description?: string;
  }>;
  sceneKinds: string[];
  transitions: Array<{
    name: string;
    builtin: boolean;
    description?: string;
  }>;
  blocks: Array<{
    id: string;
    name: string;
    category: string;
    description: string;
    defaultDurationFrames: number;
    paramSchema: Record<string, unknown>;
  }>;
}

const catalog: Catalog = {
  generatedAt: new Date().toISOString(),
  version: 1,
  primitives: listLayerPrimitives().map(p => ({
    name: p.name,
    builtin: p.builtin,
    params: p.paramWhitelist,
    description: p.description,
  })),
  sceneKinds: listSceneKinds().sort(),
  transitions: listTransitions().map(t => ({
    name: t.name,
    builtin: t.builtin,
    description: t.description,
  })),
  blocks: BLOCKS.map(b => ({
    id: b.id,
    name: b.name,
    category: b.category,
    description: b.description,
    defaultDurationFrames: b.defaultDurationFrames,
    paramSchema: b.paramSchema,
  })),
};

const outDir = join(__dirname, "..", "dist");
const outPath = join(outDir, "catalog.json");
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(catalog, null, 2) + "\n");
process.stdout.write(`Wrote ${outPath}\n`);
process.stdout.write(`  primitives: ${catalog.primitives.length}\n`);
process.stdout.write(`  sceneKinds: ${catalog.sceneKinds.length}\n`);
process.stdout.write(`  transitions: ${catalog.transitions.length}\n`);
process.stdout.write(`  blocks: ${catalog.blocks.length}\n`);
