import React from "react";
import type { VisualLayer } from "./types";
import { getLayerPrimitive, POSITION_KEYS } from "./registry";

function normalizeParams(
  allowed: ReadonlySet<string>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!allowed.has(k)) continue;
    if (POSITION_KEYS.has(k) && typeof v === "number" && v >= 0 && v <= 1) {
      out[k] = `${Math.round(v * 100)}%`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const LayerRenderer: React.FC<{ layer: VisualLayer }> = ({ layer }) => {
  const entry = getLayerPrimitive(layer.primitive);
  if (!entry) return null;
  const Comp = entry.component;
  return <Comp {...normalizeParams(entry.paramWhitelist, layer.params ?? {})} />;
};

export const LayerStack: React.FC<{ layers: VisualLayer[] }> = ({ layers }) => (
  <>
    {layers.map((layer, i) => (
      <LayerRenderer key={`${layer.primitive}-${i}`} layer={layer} />
    ))}
  </>
);
