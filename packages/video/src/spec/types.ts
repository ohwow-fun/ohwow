import type { ScenePayload } from "./kinds";

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

export type SceneKind =
  | "prompts-grid"
  | "drop"
  | "extraction"
  | "outcome-orbit"
  | "cta-mesh";

export interface CaptionSpec {
  text: string;
  highlight?: string[];
  startFrame: number;
  durationFrames: number;
}

export interface Scene<K extends SceneKind = SceneKind> {
  id: string;
  kind: K;
  durationInFrames: number;
  /**
   * v1: optional — scene components use baked-in defaults when omitted.
   * v2 will thread params through to override scene content for variants.
   */
  params?: Partial<ScenePayload[K]>;
  captions?: CaptionSpec[];
}

export interface VideoSpec {
  id: string;
  version: 1;
  fps: 30;
  width: 1280;
  height: 720;
  brand: BrandTokens;
  music?: AudioRef;
  voiceovers: AudioRef[];
  transitions: TransitionSpec[];
  scenes: Scene[];
}
