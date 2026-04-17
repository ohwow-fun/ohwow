/**
 * benchmark-bar (2D) — horizontal bar that fills from 0 to target with
 * a readable number + label. ASMR easing; warm highlight glow on the
 * fill edge.
 *
 * Use for: "93 of 100 tasks", "75% accuracy", "4.2× faster".
 *
 * Params:
 *   value:    number — fill target (required)
 *   max?:     number — denominator (default 100 → treat value as %)
 *   label?:   string — line above the bar ("SWE-bench accuracy")
 *   unit?:    string — suffix on the readout ("%", "×", "tok/s")
 *   color?:   string — fill color (default warm gold #e3b58a)
 *   track?:   string — empty-track color (default rgba(255,255,255,0.08))
 *   durationFrames?: number — how long the fill animation takes (default 60)
 *   fontSize?: number — readout size in CSS px (default 160)
 *   width?:   number — bar width in CSS px (default 1200)
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { asmrEasing } from "../../motion/asmr";

export interface BenchmarkBarProps {
  value?: number;
  max?: number;
  label?: string;
  unit?: string;
  color?: string;
  track?: string;
  durationFrames?: number;
  fontSize?: number;
  width?: number;
}

export const BenchmarkBar: React.FC<BenchmarkBarProps> = ({
  value = 50,
  max = 100,
  label,
  unit = "",
  color = "#e3b58a",
  track = "rgba(255,255,255,0.08)",
  durationFrames = 60,
  fontSize = 160,
  width = 1200,
}) => {
  const frame = useCurrentFrame();
  const ratio = max > 0 ? Math.min(1, value / max) : 0;

  const fillRatio = interpolate(frame, [10, 10 + durationFrames], [0, ratio], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: asmrEasing,
  });
  const displayValue = interpolate(frame, [10, 10 + durationFrames], [0, value], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: asmrEasing,
  });

  const barHeight = 24;
  const readoutText = `${Math.round(displayValue)}${unit}`;

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        pointerEvents: "none",
      }}
    >
      {/* Large readout number — dominant visual element */}
      <div
        style={{
          fontSize,
          fontWeight: 900,
          fontFamily: "Merriweather, Georgia, serif",
          color: "#f4eadb",
          lineHeight: 1,
          letterSpacing: "-0.02em",
          textShadow: "0 6px 24px rgba(0,0,0,0.55), 0 0 40px rgba(0,0,0,0.3)",
          marginBottom: 32,
        }}
      >
        {readoutText}
      </div>

      {/* The bar itself */}
      <div
        style={{
          width,
          height: barHeight,
          background: track,
          borderRadius: barHeight / 2,
          overflow: "hidden",
          boxShadow: "inset 0 2px 8px rgba(0,0,0,0.4)",
          position: "relative",
        }}
      >
        <div
          style={{
            width: `${fillRatio * 100}%`,
            height: "100%",
            background: `linear-gradient(90deg, ${color} 0%, #f4eadb 100%)`,
            borderRadius: barHeight / 2,
            boxShadow: `0 0 20px ${color}, 0 0 40px rgba(227, 181, 138, 0.5)`,
            transition: "width 0.1s linear",
          }}
        />
      </div>

      {label && (
        <div
          style={{
            marginTop: 28,
            fontSize: 28,
            fontWeight: 600,
            fontFamily: "Inter, system-ui, sans-serif",
            color: "#c8d4e8",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </div>
      )}
    </AbsoluteFill>
  );
};
