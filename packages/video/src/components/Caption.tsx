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
  const { fps, width } = useVideoConfig();

  // Responsive sizing. Defaults (fontSize 26, maxWidth 900) were tuned
  // for 1080×1920 Shorts — on a 1920×1080 horizontal video they read
  // like tiny corner labels. Scale up meaningfully for widescreen while
  // keeping Shorts looking the same.
  const isHorizontal = width >= 1600;
  const fontSize = isHorizontal ? 48 : 32;
  const maxWidth = isHorizontal ? Math.round(width * 0.72) : 900;
  const pad = isHorizontal ? "18px 38px" : "10px 24px";
  const bottomOffset = isHorizontal ? 96 : 60;
  const radius = isHorizontal ? 14 : 10;

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

  // Bulletproof centering: position the box at left:50% and translate it
  // back by 50% of its own width. No nested flex. Text inside uses inline
  // spans so natural text-wrap + text-align:center work as expected.
  return (
    <div
      style={{
        position: "absolute",
        bottom: bottomOffset,
        left: "50%",
        transform: `translate(-50%, ${y}px)`,
        maxWidth,
        width: "max-content",
        background: "rgba(0,0,0,0.72)",
        padding: pad,
        borderRadius: radius,
        fontFamily: fonts.sans,
        fontSize,
        fontWeight: 600,
        lineHeight: 1.35,
        textAlign: "center",
        opacity,
        boxSizing: "border-box",
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
              fontWeight: isHighlighted ? 800 : 600,
            }}
          >
            {word}
            {i < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </div>
  );
};
