/**
 * count-up (2D) — a large number that animates from 0 → target with
 * ASMR easing. Lives inside a composable scene via visualLayers.
 *
 * Params:
 *   target:     number — end value (required)
 *   unit?:      string — suffix ("%", "B", "GB", "tok/s")
 *   formatDecimals?: number — digits of precision (default 0)
 *   durationFrames?: number — count-up duration (default 45)
 *   fontSize?:  number — CSS px (default 220)
 *   color?:     string — hex (default warm cream)
 *   label?:     string — small label below the number
 *   labelColor?: string — (default #c8d4e8)
 *   position?:  "center" | "top" | "bottom" (default center)
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { asmrEasing } from "../../motion/asmr";

export interface CountUpProps {
  target?: number;
  unit?: string;
  formatDecimals?: number;
  durationFrames?: number;
  fontSize?: number;
  color?: string;
  label?: string;
  labelColor?: string;
  position?: "center" | "top" | "bottom";
}

export const CountUp: React.FC<CountUpProps> = ({
  target = 100,
  unit = "",
  formatDecimals = 0,
  durationFrames = 45,
  fontSize = 220,
  color = "#f4eadb",
  label,
  labelColor = "#c8d4e8",
  position = "center",
}) => {
  const frame = useCurrentFrame();
  const value = interpolate(frame, [5, 5 + durationFrames], [0, target], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: asmrEasing,
  });
  const displayText = formatDecimals > 0
    ? value.toFixed(formatDecimals)
    : Math.round(value).toString();

  const justifyContent =
    position === "top" ? "flex-start"
    : position === "bottom" ? "flex-end"
    : "center";

  const paddingTop = position === "top" ? 140 : 0;
  const paddingBottom = position === "bottom" ? 180 : 0;

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent,
        alignItems: "center",
        paddingTop,
        paddingBottom,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontSize,
          fontWeight: 900,
          fontFamily: "Merriweather, Georgia, serif",
          color,
          lineHeight: 1,
          textShadow: "0 6px 24px rgba(0,0,0,0.55), 0 0 40px rgba(0,0,0,0.3)",
          letterSpacing: "-0.02em",
        }}
      >
        {displayText}
        <span style={{ fontSize: fontSize * 0.42, marginLeft: "0.02em" }}>{unit}</span>
      </div>
      {label && (
        <div
          style={{
            marginTop: 24,
            fontSize: Math.round(fontSize * 0.13),
            fontWeight: 600,
            fontFamily: "Inter, system-ui, sans-serif",
            color: labelColor,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </div>
      )}
    </AbsoluteFill>
  );
};
