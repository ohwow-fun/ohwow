/**
 * Glassmorphism card with type label
 */

import React from "react";
import {
  useCurrentFrame,
  spring,
  useVideoConfig,
  interpolate,
} from "remotion";
import { colors, fonts, glass } from "./design";

const typeColors: Record<string, string> = {
  Decision: colors.accent,
  Fact: colors.blue,
  Procedure: colors.green,
  Insight: colors.purple,
  Learned: colors.accent,
};

interface GlassCardProps {
  type: string;
  text: string;
  enterFrame: number;
  width?: number;
}

export const GlassCard: React.FC<GlassCardProps> = ({
  type,
  text,
  enterFrame,
  width = 340,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = frame - enterFrame;

  if (localFrame < 0) return null;

  const enter = spring({
    fps,
    frame: localFrame,
    config: { damping: 200 },
    durationInFrames: 20,
  });

  const opacity = interpolate(enter, [0, 1], [0, 1]);
  const y = interpolate(enter, [0, 1], [30, 0]);
  const scale = interpolate(enter, [0, 1], [0.95, 1]);

  const color = typeColors[type] || colors.textMuted;

  return (
    <div
      style={{
        ...glass,
        width,
        padding: "12px 16px",
        opacity,
        transform: `translateY(${y}px) scale(${scale})`,
      }}
    >
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          fontWeight: 600,
          color,
          textTransform: "uppercase",
          letterSpacing: 1.2,
          marginBottom: 6,
        }}
      >
        {type}
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          fontSize: 14,
          color: colors.text,
          lineHeight: 1.4,
        }}
      >
        {text}
      </div>
    </div>
  );
};
