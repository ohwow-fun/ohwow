import type { VideoSpec, TransitionSpec } from "./types";

function transitionOverlap(t: TransitionSpec): number {
  return t.kind === "none" ? 0 : t.durationInFrames;
}

/**
 * Sum scene durations minus per-transition overlaps.
 * Mirrors the hand-authored arithmetic in OhwowDemo.tsx (scene N+1 starts at scene N end - overlap).
 */
export function totalDurationFrames(spec: VideoSpec): number {
  if (spec.scenes.length === 0) return 1;
  let total = 0;
  for (let i = 0; i < spec.scenes.length; i++) {
    total += spec.scenes[i].durationInFrames;
    if (i < spec.scenes.length - 1) {
      const t = spec.transitions[i];
      if (t) total -= transitionOverlap(t);
    }
  }
  return total;
}
