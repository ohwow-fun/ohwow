/**
 * Brand-kit loader. Reads one of the JSON files under
 * `packages/video/brand-kits/<slug>.json` and returns a typed BrandKit.
 *
 * Callers (the compose pipeline, the brand-kit audit CLI, the Remotion
 * renderer) load at runtime rather than statically-importing so that authors
 * can iterate on kit JSONs without rebuilding the package.
 */
import fs from "node:fs";
import path from "node:path";

import type { BrandKit } from "./types";

export type { BrandKit, SceneMood, MotionStyle } from "./types";

/**
 * Resolved relative to this module so the loader works whether the caller is
 * the CLI (inside scripts/), the daemon (inside src/), or the video package
 * itself. `__dirname` is provided by CommonJS output.
 */
const BRAND_KITS_DIR = path.resolve(__dirname, "..", "..", "brand-kits");

export function brandKitPath(slug: string): string {
  return path.join(BRAND_KITS_DIR, `${slug}.json`);
}

export function loadBrandKit(slug: string): BrandKit {
  const p = brandKitPath(slug);
  if (!fs.existsSync(p)) {
    throw new Error(`brand kit not found: ${p}`);
  }
  const raw = fs.readFileSync(p, "utf8");
  const kit = JSON.parse(raw) as BrandKit;
  if (kit.slug !== slug) {
    throw new Error(
      `brand kit slug mismatch: file=${slug} json.slug=${kit.slug}`,
    );
  }
  return kit;
}

export function listBrandKitSlugs(): string[] {
  if (!fs.existsSync(BRAND_KITS_DIR)) return [];
  return fs
    .readdirSync(BRAND_KITS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}
