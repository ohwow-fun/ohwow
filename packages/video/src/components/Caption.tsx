/**
 * Animated caption overlay.
 *
 * HORIZONTAL (1920×1080, Briefing / playlist content): Netflix-style
 * floating caption — clean centered text, heavy text-shadow for
 * readability against any backdrop. No box chrome. Premium newsroom feel.
 *
 * VERTICAL (1080×1920, Shorts): TikTok-style burned-in subtitle with a
 * dark background bed. Skim-readable for fast-feed consumption.
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

  const isHorizontal = width >= 1600;

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

  // ─── Horizontal: Netflix-style floating caption ──────────────────────
  // No box. Full-viewport flex container centers the inline text block
  // reliably regardless of Remotion's bundle quirks. Text-align:center
  // alone was producing visibly-off-center output in the rendered MP4.
  // Heavy text-shadow keeps readability on any primitive backdrop.
  if (isHorizontal) {
    const fontSize = 56;
    const textShadow = [
      "0 2px 4px rgba(0,0,0,0.95)",
      "0 4px 12px rgba(0,0,0,0.85)",
      "0 0 22px rgba(0,0,0,0.7)",
      "0 0 40px rgba(0,0,0,0.5)",
    ].join(", ");
    return (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 120,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: "0 160px",
          opacity,
          transform: `translateY(${y}px)`,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize,
            fontWeight: 800,
            lineHeight: 1.25,
            color: colors.text,
            textShadow,
            textAlign: "center",
            maxWidth: "100%",
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
                  fontWeight: 800,
                }}
              >
                {word}
                {i < words.length - 1 ? " " : ""}
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── Vertical: TikTok-style box ──────────────────────────────────────
  const fontSize = 32;
  const maxWidth = 900;
  return (
    <div
      style={{
        position: "absolute",
        bottom: 60,
        left: "50%",
        transform: `translate(-50%, ${y}px)`,
        maxWidth,
        width: "max-content",
        background: "rgba(0,0,0,0.72)",
        padding: "10px 24px",
        borderRadius: 10,
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
