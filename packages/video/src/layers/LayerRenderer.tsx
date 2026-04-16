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

export const LayerRenderer: React.FC<{ layer: VisualLayer }> = ({ layer }) => {
  const Comp = PRIMITIVE_MAP[layer.primitive];
  if (!Comp) return null;
  return <Comp {...(layer.params ?? {})} />;
};

export const LayerStack: React.FC<{ layers: VisualLayer[] }> = ({ layers }) => (
  <>
    {layers.map((layer, i) => (
      <LayerRenderer key={`${layer.primitive}-${i}`} layer={layer} />
    ))}
  </>
);
