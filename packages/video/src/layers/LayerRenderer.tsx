import React from "react";
import type { VisualLayer, VisualLayerPrimitive } from "./types";
import {
  Aurora,
  Bokeh,
  LightRays,
  ConstellationNet,
  WaveForm,
  GeometricShapes,
  Vignette,
  RippleRings,
  GradientWash,
  FlowFieldLayer,
  PulseRing,
  GlowOrb,
  NoiseGrid,
  ScanLine,
  FilmGrain,
  ParticleBurst,
  GridMorph,
  TextShadowTrail,
} from "../motion/generative";
import { VideoClipLayer } from "./VideoClipLayer";

type PrimitiveComponent = React.FC<Record<string, unknown>>;

const PRIMITIVE_MAP: Record<VisualLayerPrimitive, PrimitiveComponent> = {
  aurora: Aurora as PrimitiveComponent,
  bokeh: Bokeh as PrimitiveComponent,
  "light-rays": LightRays as PrimitiveComponent,
  constellation: ConstellationNet as PrimitiveComponent,
  waveform: WaveForm as PrimitiveComponent,
  geometric: GeometricShapes as PrimitiveComponent,
  vignette: Vignette as PrimitiveComponent,
  ripple: RippleRings as PrimitiveComponent,
  "gradient-wash": GradientWash as PrimitiveComponent,
  "flow-field": FlowFieldLayer as PrimitiveComponent,
  "pulse-ring": PulseRing as PrimitiveComponent,
  "glow-orb": GlowOrb as PrimitiveComponent,
  "noise-grid": NoiseGrid as PrimitiveComponent,
  "scan-line": ScanLine as PrimitiveComponent,
  "film-grain": FilmGrain as PrimitiveComponent,
  "particle-burst": ParticleBurst as PrimitiveComponent,
  "grid-morph": GridMorph as PrimitiveComponent,
  "text-shadow-trail": TextShadowTrail as PrimitiveComponent,
  "video-clip": VideoClipLayer as PrimitiveComponent,
};

const POSITION_KEYS = new Set(["cx", "cy", "originX", "originY", "y"]);

const PARAM_WHITELIST: Record<VisualLayerPrimitive, Set<string>> = {
  aurora: new Set(["colors", "speed", "opacity", "y"]),
  bokeh: new Set(["count", "colors", "seed", "minSize", "maxSize", "speed"]),
  "light-rays": new Set(["count", "color", "originX", "originY", "spread", "speed", "opacity"]),
  constellation: new Set(["nodeCount", "color", "seed", "speed", "lineOpacity", "dotSize"]),
  waveform: new Set(["color", "amplitude", "frequency", "speed", "y", "opacity", "layers"]),
  geometric: new Set(["count", "color", "seed", "speed", "opacity", "shapes"]),
  vignette: new Set(["intensity", "color"]),
  ripple: new Set(["cx", "cy", "color", "count", "speed", "maxRadius", "opacity"]),
  "gradient-wash": new Set(["colors", "speed", "angle", "opacity"]),
  "flow-field": new Set(["count", "seed", "speed", "colors", "width", "height"]),
  "pulse-ring": new Set(["cx", "cy", "radius", "color", "speed", "thickness"]),
  "glow-orb": new Set(["cx", "cy", "size", "color", "pulseSpeed"]),
  "noise-grid": new Set(["cols", "rows", "cellSize", "seed", "color", "speed"]),
  "scan-line": new Set(["color", "speed", "opacity"]),
  "film-grain": new Set(["intensity"]),
  "particle-burst": new Set(["count", "color", "seed", "speed", "size", "cx", "cy"]),
  "grid-morph": new Set(["cols", "rows", "cellSize", "color", "seed", "speed", "morphIntensity"]),
  "text-shadow-trail": new Set(["text", "color", "trailColor", "trailCount", "speed", "fontSize"]),
  "video-clip": new Set(["src", "opacity", "blendMode", "fit", "muted"]),
};

function normalizeParams(
  primitive: VisualLayerPrimitive,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = PARAM_WHITELIST[primitive];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!allowed?.has(k)) continue;
    if (POSITION_KEYS.has(k) && typeof v === "number" && v >= 0 && v <= 1) {
      out[k] = `${Math.round(v * 100)}%`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const LayerRenderer: React.FC<{ layer: VisualLayer }> = ({ layer }) => {
  const Comp = PRIMITIVE_MAP[layer.primitive];
  if (!Comp) return null;
  return <Comp {...normalizeParams(layer.primitive, layer.params ?? {})} />;
};

export const LayerStack: React.FC<{ layers: VisualLayer[] }> = ({ layers }) => (
  <>
    {layers.map((layer, i) => (
      <LayerRenderer key={`${layer.primitive}-${i}`} layer={layer} />
    ))}
  </>
);
