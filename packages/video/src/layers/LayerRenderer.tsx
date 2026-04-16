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
} from "../motion/generative";

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
};

const POSITION_KEYS = new Set(["cx", "cy", "originX", "originY", "y"]);

function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
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
  return <Comp {...normalizeParams(layer.params ?? {})} />;
};

export const LayerStack: React.FC<{ layers: VisualLayer[] }> = ({ layers }) => (
  <>
    {layers.map((layer, i) => (
      <LayerRenderer key={`${layer.primitive}-${i}`} layer={layer} />
    ))}
  </>
);
