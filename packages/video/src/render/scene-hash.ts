import { createHash } from "node:crypto";
import type { Scene, VideoSpec, AudioRef, BrandTokens, VideoPalette } from "../spec/types";

/**
 * Context factors that affect how a scene renders. Two scenes that are
 * identical in shape render differently when their palette, brand tokens,
 * resolution, or voiceover changes — so those ride along in the hash.
 */
export interface SceneHashContext {
  brand: BrandTokens;
  palette?: VideoPalette;
  fps: number;
  width: number;
  height: number;
  /** Voiceovers whose timeline overlaps this scene. */
  overlappingVoiceovers: AudioRef[];
  /** Music ref if it overlaps. */
  music?: AudioRef;
}

/**
 * Stable stringification mirrored from src/media/asset-cache.ts so the same
 * input always produces the same hash regardless of property-insertion order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function hashScene(scene: Scene, ctx: SceneHashContext): string {
  const payload = {
    scene: {
      kind: scene.kind,
      durationInFrames: scene.durationInFrames,
      params: scene.params ?? null,
      captions: scene.captions ?? null,
      narration: scene.narration ?? null,
    },
    ctx: {
      brand: ctx.brand,
      palette: ctx.palette ?? null,
      fps: ctx.fps,
      width: ctx.width,
      height: ctx.height,
      overlappingVoiceovers: ctx.overlappingVoiceovers,
      music: ctx.music ?? null,
    },
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/**
 * Compute the absolute start + end frame for each scene in a spec, accounting
 * for transition overlaps. Returns [start, end) pairs (exclusive end).
 */
export function sceneAbsoluteRanges(spec: VideoSpec): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (let i = 0; i < spec.scenes.length; i++) {
    const start = cursor;
    cursor += spec.scenes[i].durationInFrames;
    const end = cursor;
    ranges.push({ start, end });
    const t = spec.transitions[i];
    if (i < spec.scenes.length - 1 && t && t.kind !== "none") {
      cursor -= t.durationInFrames;
    }
  }
  return ranges;
}

/**
 * Return the AudioRef subset that overlaps a given scene's absolute range.
 * A voiceover overlaps if [vStart, vEnd) intersects [sceneStart, sceneEnd).
 */
export function audioRefsOverlappingScene(
  refs: AudioRef[],
  range: { start: number; end: number },
): AudioRef[] {
  return refs.filter(v => {
    const vStart = v.startFrame;
    const vEnd = v.durationFrames != null ? v.startFrame + v.durationFrames : Number.POSITIVE_INFINITY;
    return vStart < range.end && vEnd > range.start;
  });
}

export function hashScenesInSpec(spec: VideoSpec): Array<{ sceneId: string; hash: string }> {
  const ranges = sceneAbsoluteRanges(spec);
  return spec.scenes.map((scene, i) => {
    const range = ranges[i];
    const ctx: SceneHashContext = {
      brand: spec.brand,
      palette: spec.palette,
      fps: spec.fps,
      width: spec.width,
      height: spec.height,
      overlappingVoiceovers: audioRefsOverlappingScene(spec.voiceovers, range),
      music: spec.music && audioRefsOverlappingScene([spec.music], range).length > 0 ? spec.music : undefined,
    };
    return { sceneId: scene.id, hash: hashScene(scene, ctx) };
  });
}
