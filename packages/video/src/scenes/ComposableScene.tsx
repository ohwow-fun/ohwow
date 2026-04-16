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
  bgIntensity?: number;
  palette?: VideoPalette;
  sceneIndex?: number;
}

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
  const intensity = params?.bgIntensity ?? 0.6;

  let layers = params?.visualLayers ?? [];

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
