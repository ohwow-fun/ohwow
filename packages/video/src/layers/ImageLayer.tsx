import React from "react";
import { Img, staticFile, useCurrentFrame, interpolate } from "remotion";

/**
 * Renders a static image positioned by cx/cy (0–1 center ratios).
 * Used primarily for the ohwow logo in the Tomorrow Broke outro scene.
 */
export const ImageLayer: React.FC<Record<string, unknown>> = (props) => {
  const src = props.src as string | undefined;
  if (!src) return null;

  const frame = useCurrentFrame();
  const width       = (props.width   as number) ?? 120;
  const height      = (props.height  as number) ?? 120;
  // LayerRenderer pre-converts 0-1 ratios to "50%" strings via POSITION_KEYS;
  // accept both forms so the component works inside and outside a LayerStack.
  const cx          = (props.cx as string | number | undefined) ?? "50%";
  const cy          = (props.cy as string | number | undefined) ?? "50%";
  const left        = typeof cx === "number" ? `${cx * 100}%` : cx;
  const top         = typeof cy === "number" ? `${cy * 100}%` : cy;
  const fadeIn      = (props.fadeIn  as number) ?? 0;
  const baseOpacity = (props.opacity as number) ?? 1;

  const alpha = fadeIn > 0
    ? interpolate(frame, [0, fadeIn], [0, baseOpacity], { extrapolateRight: "clamp" })
    : baseOpacity;

  const resolvedSrc = src.startsWith("http") ? src : staticFile(src);

  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        transform: "translate(-50%, -50%)",
        width,
        height,
        opacity: alpha,
        pointerEvents: "none",
      }}
    >
      <Img
        src={resolvedSrc}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    </div>
  );
};
