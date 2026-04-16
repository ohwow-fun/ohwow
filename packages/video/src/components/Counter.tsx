/**
 * Animated counter that ticks up
 */

import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { colors, fonts } from "./design";

interface CounterProps {
  from: number;
  to: number;
  startFrame: number;
  durationFrames: number;
  label: string;
  color?: string;
}

export const Counter: React.FC<CounterProps> = ({
  from,
  to,
  startFrame,
  durationFrames,
  label,
  color = colors.accent,
}) => {
  const frame = useCurrentFrame();
  const localFrame = frame - startFrame;

  if (localFrame < 0) return null;

  const progress = interpolate(localFrame, [0, durationFrames], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Ease out cubic
  const eased = 1 - Math.pow(1 - progress, 3);
  const value = Math.round(from + (to - from) * eased);

  const opacity = interpolate(localFrame, [0, 8], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        opacity,
        fontFamily: fonts.mono,
      }}
    >
      <span style={{ fontSize: 28, fontWeight: 700, color }}>
        {value.toLocaleString()}
      </span>
      <span style={{ fontSize: 14, color: colors.textMuted }}>{label}</span>
    </div>
  );
};
