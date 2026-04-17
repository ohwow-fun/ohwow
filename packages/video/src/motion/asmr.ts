/**
 * ASMR motion profile — slow, soft, breath-paced motion primitives.
 *
 * All motion primitives (semantic 2D, R3F 3D) apply these defaults when
 * the enclosing series' motionProfile === 'asmr'. The aesthetic target
 * is oddly-satisfying: slow-in-slow-out easing, gentle oscillations,
 * reflective materials, warm palettes. No frantic snapping, no hard
 * cuts, no linear-zip interpolation.
 *
 * Usage:
 *   const t = interpolate(frame, [0, 60], [0, 1], { easing: asmrEasing });
 *   const opacity = 0.8 + breathCycle(frame, 180, 0.15);
 *   const drift = driftVector(frame, seed, 0.003);
 */

import { Easing } from "remotion";

/**
 * Slow-in-slow-out cubic bezier tuned softer than the default.
 * Real easeInOutCubic is (0.65, 0, 0.35, 1). ASMR softens the ends
 * to (0.42, 0, 0.58, 1) — the motion starts lazier and lands lazier.
 */
export const asmrEasing = Easing.bezier(0.42, 0, 0.58, 1);

/**
 * Even softer variant for depth/3D motion where we want an exaggerated
 * glide — perfect for camera pulls, chrome-material rotations.
 */
export const asmrEasingDeep = Easing.bezier(0.22, 0.02, 0.36, 1);

/**
 * Periodic oscillation for opacity / scale breathing. Returns a value in
 * [-amp, +amp] following a smooth sine wave with the given period.
 *
 * Example: breathCycle(frame, 180, 0.1) oscillates ±10% over 6 seconds
 * at 30fps. Good for subtle background-light pulses.
 */
export function breathCycle(frame: number, periodFrames: number, amp = 0.1): number {
  if (periodFrames <= 0) return 0;
  const phase = (frame / periodFrames) * Math.PI * 2;
  return Math.sin(phase) * amp;
}

/**
 * Deterministic 2D drift vector for background elements. Uses a seeded
 * low-frequency pseudo-noise so elements glide rather than jitter.
 *
 * Returns {x, y} in [-speed, +speed] * (canvas-normalized unit).
 * Multiply by canvas width/height at call site.
 */
export function driftVector(frame: number, seed: number, speed = 0.003): { x: number; y: number } {
  // Two offset sines with different periods = pseudo-noise that feels natural.
  const a = seed * 17.31 + frame * speed * 2 * Math.PI;
  const b = seed * 29.73 + frame * speed * 1.7 * Math.PI;
  return {
    x: Math.sin(a) * 0.5 + Math.sin(a * 0.37 + 1.3) * 0.5,
    y: Math.cos(b) * 0.5 + Math.cos(b * 0.41 + 0.7) * 0.5,
  };
}

/**
 * Soft chrome material preset for R3F <meshStandardMaterial>. Tuned for
 * broadcast-friendly highlights: high metalness, low roughness, warm
 * envMapIntensity. Drop into a mesh as `{...chromeMaterialPreset}`.
 */
export const chromeMaterialPreset = {
  metalness: 0.9,
  roughness: 0.18,
  envMapIntensity: 1.2,
  // A warm gold undertone under neutral light. Override color per scene.
  color: "#f4eadb",
} as const;

/**
 * Frosted glass material preset. For caption-backing slabs and floating
 * information cards.
 */
export const glassMaterialPreset = {
  metalness: 0.1,
  roughness: 0.08,
  transmission: 0.95,
  thickness: 0.5,
  ior: 1.5,
  attenuationColor: "#d8e8ff",
  attenuationDistance: 2.0,
  envMapIntensity: 0.8,
} as const;

/**
 * Warm palette targets. Callers can bias any hex color toward these
 * using mixToward() if the scene's kit palette skews cool.
 */
export const warmPalettePreset = {
  // Slight cream highlight
  highlight: "#fff4e6",
  // Amber mid-tone
  mid: "#f0c89b",
  // Dark umber for shadows
  shadow: "#2a1d15",
  // Warm-neutral accent (rose-gold-ish)
  accent: "#e3b58a",
} as const;

/**
 * Per-profile motion parameters. `asmr` everywhere = slow; `crisp` for
 * newsroom energy; `chaotic` for Bot Beats (v2).
 */
export const MOTION_PROFILES = {
  asmr: {
    easing: asmrEasing,
    crossfadeFrames: 24, // 0.8s at 30fps
    breathPeriodFrames: 180, // 6s
    breathAmp: 0.12,
    backgroundDriftSpeed: 0.0025,
    sceneEntryFrames: 18,
    sceneExitFrames: 18,
  },
  crisp: {
    easing: Easing.bezier(0.4, 0, 0.2, 1),
    crossfadeFrames: 8, // 0.27s
    breathPeriodFrames: 0, // disabled
    breathAmp: 0,
    backgroundDriftSpeed: 0.006,
    sceneEntryFrames: 10,
    sceneExitFrames: 10,
  },
  chaotic: {
    easing: Easing.bezier(0.2, 0.8, 0.3, 1), // snappy bounce
    crossfadeFrames: 2, // hard cut feel
    breathPeriodFrames: 0,
    breathAmp: 0,
    backgroundDriftSpeed: 0.012,
    sceneEntryFrames: 6,
    sceneExitFrames: 6,
  },
} as const;

export type MotionProfile = keyof typeof MOTION_PROFILES;

/**
 * Resolve a motion profile by name. Defaults to 'asmr' if name unknown.
 */
export function getMotionProfile(name: string | undefined): (typeof MOTION_PROFILES)[MotionProfile] {
  if (name && name in MOTION_PROFILES) {
    return MOTION_PROFILES[name as MotionProfile];
  }
  return MOTION_PROFILES.asmr;
}
