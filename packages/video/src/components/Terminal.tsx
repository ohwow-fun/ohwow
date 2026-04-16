/**
 * Terminal — Glass-styled CLI block with typewriter animation
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { colors, fonts, glass } from "./design";

interface TerminalLine {
  text: string;
  color?: string;
  delay: number; // frames before this line starts typing
  prefix?: string; // e.g., "$ " or ">" or ""
  speed?: number; // chars per frame (default 1.5)
}

interface TerminalProps {
  lines: TerminalLine[];
  title?: string;
  enterFrame?: number;
  width?: number;
  height?: number;
}

export const Terminal: React.FC<TerminalProps> = ({
  lines,
  title = "terminal",
  enterFrame = 0,
  width = 560,
  height,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = frame - enterFrame;

  if (localFrame < 0) return null;

  const enter = spring({
    fps,
    frame: localFrame,
    config: { damping: 200 },
    durationInFrames: 15,
  });

  return (
    <div
      style={{
        ...glass,
        width,
        height,
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [20, 0])}px)`,
        overflow: "hidden",
      }}
    >
      {/* Title bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 12px",
          borderBottom: `1px solid ${colors.cardBorder}`,
        }}
      >
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ff5f57" }} />
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#febc2e" }} />
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#28c840" }} />
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: colors.textDim,
            marginLeft: 8,
          }}
        >
          {title}
        </span>
      </div>

      {/* Content */}
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
        {lines.map((line, i) => {
          const lineFrame = localFrame - line.delay;
          if (lineFrame < 0) return null;

          const speed = line.speed ?? 1.5;
          const chars = Math.min(
            line.text.length,
            Math.floor(lineFrame * speed)
          );
          const showCursor = chars < line.text.length;
          const prefix = line.prefix ?? "$ ";

          return (
            <div
              key={i}
              style={{
                fontFamily: fonts.mono,
                fontSize: 13,
                lineHeight: 1.6,
                color: line.color || colors.text,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              <span style={{ color: colors.green }}>{prefix}</span>
              {line.text.slice(0, chars)}
              {showCursor && (
                <span
                  style={{
                    color: colors.accent,
                    opacity: Math.sin(frame * 0.15) > 0 ? 1 : 0,
                  }}
                >
                  |
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
