import type { ScenePayload } from "./kinds";
import type { VisualLayer, TextLayer, VideoPalette } from "../layers/types";

export type { VisualLayer, TextLayer, VideoPalette };

export interface BrandTokens {
  colors: Record<string, string>;
  fonts: { sans: string; mono: string; display: string };
  glass: {
    background: string;
    border: string;
    borderRadius: number;
    backdropFilter: string;
  };
}

export interface AudioRef {
  src: string;
  startFrame: number;
  durationFrames?: number;
  volume?: number;
}

export type WipeDirection =
  | "from-left"
  | "from-right"
  | "from-top"
  | "from-bottom";

export type TransitionSpec =
  | {
      kind: "fade";
      durationInFrames: number;
      spring?: { damping: number; durationRestThreshold?: number };
    }
  | { kind: "slide"; direction: "from-left" | "from-right"; durationInFrames: number }
  | { kind: "wipe"; direction: WipeDirection; durationInFrames: number }
  | { kind: "none" };

/**
 * Built-in scene kinds shipped with @ohwow/video. The type is a plain string
 * so consumers can register custom kinds via registerSceneKind() without
 * touching this file.
 */
export type BuiltinSceneKind =
  | "prompts-grid"
  | "drop"
  | "extraction"
  | "outcome-orbit"
  | "cta-mesh";

export type SceneKind = BuiltinSceneKind | (string & {});

export interface CaptionSpec {
  text: string;
  highlight?: string[];
  startFrame: number;
  durationFrames: number;
}

/**
 * A single motion-graphic beat — one primitive (semantic 2D or R3F 3D)
 * with its params. The motion-beats compiler reads `motion_beats` off a
 * Scene and translates the list into the right `params` shape for the
 * target scene kind (visualLayers for composable, primitives for
 * r3f-scene).
 *
 * Keeping this flat (no nested timeline) in v1. `at` and `duration` are
 * reserved for a future timeline phase; today all beats run for the full
 * scene duration, layered bottom-to-top in array order.
 */
export interface MotionBeat {
  /** Registered primitive name. 2D: "count-up", "grid-morph", etc. 3D: "r3f.count-up-bar", "r3f.particle-cloud", etc. */
  primitive: string;
  /** Primitive-specific params. Forwarded verbatim to the component. */
  params?: Record<string, unknown>;
  /**
   * Reserved for timeline-based beats in a future phase. Ignored in v1.
   */
  at?: number;
  /**
   * Reserved for timeline-based beats in a future phase. Ignored in v1.
   */
  duration?: number;
}

export interface Scene<K extends string = SceneKind> {
  id: string;
  kind: K;
  durationInFrames: number;
  /** Visual params. Shape depends on kind. Scenes fall back to baked-in defaults when omitted. */
  params?: Record<string, unknown>;
  /** If provided, composition renders these as subtitle overlays at global time = scene start + caption.startFrame. */
  captions?: CaptionSpec[];
  /** Raw narration text. Used by the composition to auto-generate captions when captions[] is absent. */
  narration?: string;
  /**
   * Plain-language description of what the scene should VISUALLY show —
   * the LLM's intent in its own words. The compose pipeline does not use
   * this at render time; it's carried forward as provenance so human
   * reviewers and future resolver passes can see the intent behind the
   * beats. Authors may set this alongside or instead of motion_beats.
   */
  motion_graphic_prompt?: string;
  /**
   * Per-scene motion-graphic beats. When present, the motion-beats
   * compiler derives this scene's `kind` and `params` from the beats
   * (e.g., all r3f.* beats → kind "r3f-scene" with params.primitives;
   * 2D beats → kind "composable" with params.visualLayers). When absent,
   * the scene's existing `kind` + `params` are used as-is.
   */
  motion_beats?: MotionBeat[];
  /**
   * When true, the compose pipeline runs a separate coding-LLM pass to
   * write a bespoke TSX scene component for this scene, keyed to the
   * motion_graphic_prompt + narration. The generated file registers a
   * custom scene kind ("custom-<sceneId>"). Gated by a per-episode
   * budget (default 1). On any validation failure the scene falls back
   * to the beats-compiled shape. See scripts/yt-experiments/_custom-scene-codegen.mjs.
   */
  custom_codegen?: boolean;
  /** Optional metadata consumed by lints and tools (e.g., voiceDurationMs from the workspace author). */
  metadata?: {
    voiceDurationMs?: number;
    [key: string]: unknown;
  };
}

export interface VideoSpec {
  id: string;
  version: 1;
  fps: number;
  width: number;
  height: number;
  brand: BrandTokens;
  palette?: VideoPalette;
  music?: AudioRef;
  voiceovers: AudioRef[];
  transitions: TransitionSpec[];
  scenes: Scene[];
  /**
   * Optional reference to a per-series brand kit (e.g., 'briefing',
   * 'mind-wars'). Purely informational at render time — the compose
   * pipeline has already merged the kit's colors/fonts/glass into
   * `brand` above before the spec reaches the renderer. Preserved here
   * so brief.json files carry traceable provenance ("this was rendered
   * with the briefing kit").
   */
  brandKitRef?: string;
}
