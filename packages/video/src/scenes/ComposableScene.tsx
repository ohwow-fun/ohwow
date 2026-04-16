import React from "react";
import type { VisualLayer, TextLayer, VideoPalette } from "../layers/types";
import { LayerStack } from "../layers/LayerRenderer";
import { TextLayerRenderer } from "../layers/TextLayerRenderer";
import {
  SceneBackground,
  getMoodColors,
  moodForIndex,
  palette as generatePalette,
  type SceneMood,
} from "../motion/generative";

export interface ComposableSceneParams {
  visualLayers?: VisualLayer[];
  text?: TextLayer;
  mood?: SceneMood;
  pacing?: "urgent" | "steady" | "reflective";
  bgIntensity?: number;
  palette?: VideoPalette;
  sceneIndex?: number;
}

interface PacingProfile {
  speedMultiplier: number;
  opacityBoost: number;
  bgIntensity: number;
}

const PACING_PROFILES: Record<string, PacingProfile> = {
  urgent:     { speedMultiplier: 1.8, opacityBoost: 0.04, bgIntensity: 0.8 },
  steady:     { speedMultiplier: 1.0, opacityBoost: 0.0,  bgIntensity: 0.6 },
  reflective: { speedMultiplier: 0.5, opacityBoost: -0.02, bgIntensity: 0.4 },
};

const MOOD_PACING: Record<string, string> = {
  dark: "steady",
  warm: "reflective",
  cool: "steady",
  electric: "urgent",
  forest: "reflective",
  sunset: "reflective",
  midnight: "steady",
};

/**
 * Universal scene that renders any combination of visual primitives + text.
 * The LLM describes the visual composition; this component assembles it.
 *
 * Layer order (bottom to top):
 *   1. SceneBackground (mood-derived gradient)
 *   2. Visual layers in array order (first = deepest)
 *   3. Text layer (content + animation)
 */
export const ComposableScene: React.FC<{
  params?: Partial<ComposableSceneParams>;
  durationInFrames?: number;
}> = ({ params, durationInFrames }) => {
  const sceneIndex = params?.sceneIndex ?? 0;
  const videoPalette = params?.palette;

  const mood = params?.mood
    ?? videoPalette?.mood
    ?? moodForIndex(sceneIndex);

  const m = getMoodColors(mood);
  const pacingKey = params?.pacing ?? MOOD_PACING[mood] ?? "steady";
  const pacing = PACING_PROFILES[pacingKey] ?? PACING_PROFILES.steady;
  const intensity = params?.bgIntensity ?? pacing.bgIntensity;

  let layers = params?.visualLayers ?? [];

  if (layers.length > 0) {
    layers = layers.map(layer => applyPacing(layer, pacing));
  }

  if (videoPalette && layers.length > 0) {
    const pal = generatePalette(videoPalette.seedHue, 5, videoPalette.harmony);
    layers = layers.map(layer => injectPaletteColors(layer, pal, m));
  }

  return (
    <SceneBackground mood={mood} intensity={intensity}>
      <LayerStack layers={layers} />
      {params?.text && (
        <TextLayerRenderer
          config={{
            ...params.text,
            accentColor: params.text.accentColor ?? m.accent,
          }}
          durationInFrames={durationInFrames}
        />
      )}
    </SceneBackground>
  );
};

/**
 * Apply pacing profile to a layer's speed and opacity if the layer
 * doesn't already set them explicitly.
 */
function applyPacing(layer: VisualLayer, pacing: PacingProfile): VisualLayer {
  const p = layer.params ?? {};
  const patched: Record<string, unknown> = { ...p };
  let changed = false;

  if (!("speed" in p) && pacing.speedMultiplier !== 1.0) {
    const defaults: Record<string, number> = {
      aurora: 0.008, bokeh: 0.003, "light-rays": 0.01,
      constellation: 0.002, waveform: 0.04, geometric: 0.005,
      ripple: 0.6, "flow-field": 1, "noise-grid": 0.005, "scan-line": 0.4,
    };
    const base = defaults[layer.primitive];
    if (base !== undefined) {
      patched.speed = base * pacing.speedMultiplier;
      changed = true;
    }
  }

  if (!("opacity" in p) && pacing.opacityBoost !== 0) {
    const defaults: Record<string, number> = {
      aurora: 0.15, bokeh: 0.1, "light-rays": 0.04,
      constellation: 0.08, waveform: 0.15, geometric: 0.06,
      ripple: 0.1, "gradient-wash": 0.08, "flow-field": 0.6,
    };
    const base = defaults[layer.primitive];
    if (base !== undefined) {
      patched.opacity = Math.max(0.01, base + pacing.opacityBoost);
      changed = true;
    }
  }

  return changed ? { ...layer, params: patched } : layer;
}

/**
 * When a layer doesn't specify colors, derive them from the video palette.
 * Only fills in missing color params; explicit colors pass through.
 */
function injectPaletteColors(
  layer: VisualLayer,
  pal: Array<{ hex: string }>,
  mood: { accent: string; secondary: string },
): VisualLayer {
  const p = layer.params ?? {};

  const hasColor = "color" in p || "colors" in p;
  if (hasColor) return layer;

  const colorPrimitives: Record<string, string> = {
    aurora: "colors",
    bokeh: "colors",
    "gradient-wash": "colors",
    "flow-field": "colors",
  };

  const singleColorPrimitives = new Set([
    "light-rays", "constellation", "waveform", "geometric",
    "ripple", "pulse-ring", "glow-orb", "noise-grid", "scan-line",
  ]);

  if (layer.primitive in colorPrimitives) {
    return {
      ...layer,
      params: {
        ...p,
        [colorPrimitives[layer.primitive]]: [pal[0].hex, pal[1].hex, pal[2].hex],
      },
    };
  }

  if (singleColorPrimitives.has(layer.primitive)) {
    return {
      ...layer,
      params: { ...p, color: mood.accent },
    };
  }

  return layer;
}
