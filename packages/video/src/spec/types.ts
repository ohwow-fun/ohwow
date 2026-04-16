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

export type TransitionSpec =
  | {
      kind: "fade";
      durationInFrames: number;
      spring?: { damping: number; durationRestThreshold?: number };
    }
  | { kind: "slide"; direction: "from-left" | "from-right"; durationInFrames: number }
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

export interface Scene<K extends string = SceneKind> {
  id: string;
  kind: K;
  durationInFrames: number;
  /** Visual params — shape depends on kind. Scenes fall back to baked-in defaults when omitted. */
  params?: Record<string, unknown>;
  /** If provided, composition renders these as subtitle overlays at global time = scene start + caption.startFrame. */
  captions?: CaptionSpec[];
  /** Raw narration text. Used by the composition to auto-generate captions when captions[] is absent. */
  narration?: string;
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
}
