/**
 * Animated caption overlay — TikTok-style burned-in subtitles
 * Key words highlighted in accent color
 */

import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { colors, fonts } from "./design";

interface CaptionProps {
  text: string;
  highlight?: string[];
  startFrame: number;
  durationFrames: number;
}

export const Caption: React.FC<CaptionProps> = ({
  text,
  highlight = [],
  startFrame,
  durationFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = frame - startFrame;
  if (localFrame < 0 || localFrame > durationFrames) return null;

  const enter = spring({
    fps,
    frame: localFrame,
    config: { damping: 200 },
    durationInFrames: 12,
  });

  const exit = interpolate(
    localFrame,
    [durationFrames - 10, durationFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const opacity = Math.min(enter, exit);
  const y = interpolate(enter, [0, 1], [20, 0]);

  const words = text.split(" ");

  return (
    <div
      style={{
        position: "absolute",
        bottom: 60,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        opacity,
        transform: `translateY(${y}px)`,
      }}
    >
      <div
        style={{
          background: "rgba(0,0,0,0.65)",
          padding: "10px 24px",
          borderRadius: 10,
          fontFamily: fonts.sans,
          fontSize: 26,
          fontWeight: 500,
          lineHeight: 1.4,
          maxWidth: 900,
          textAlign: "center",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "0 6px",
        }}
      >
        {words.map((word, i) => {
          const clean = word.replace(/[.,!?]/g, "").toLowerCase();
          const isHighlighted = highlight.some(
            (h) => clean === h.toLowerCase()
          );
          return (
            <span
              key={i}
              style={{
                color: isHighlighted ? colors.accent : colors.text,
                fontWeight: isHighlighted ? 700 : 500,
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
    </div>
  );
};
