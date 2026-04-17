/**
 * spec-list (2D) — 2-5 key:value rows that reveal sequentially with
 * ASMR pacing. For model specs, pricing tiers, feature lists.
 *
 * Example items: [
 *   { key: "Parameters", value: "35B" },
 *   { key: "Quantization", value: "20.9GB GGUF" },
 *   { key: "Throughput", value: "40+ tok/s" },
 *   { key: "Hardware", value: "RTX 3060 12GB" },
 * ]
 *
 * Params:
 *   items:    Array<{key, value, accent?}> (required)
 *   heading?: string — title above the list
 *   pacing?:  number — frames between row reveals (default 18)
 *   startAt?: number — frame when first row reveals (default 8)
 *   align?:   "center" | "left" (default center)
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { asmrEasing } from "../../motion/asmr";

interface SpecItem {
  key: string;
  value: string;
  accent?: boolean;
}

export interface SpecListProps {
  items?: SpecItem[];
  heading?: string;
  pacing?: number;
  startAt?: number;
  align?: "center" | "left";
}

export const SpecList: React.FC<SpecListProps> = ({
  items = [],
  heading,
  pacing = 18,
  startAt = 8,
  align = "center",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headingOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: asmrEasing,
  });

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "left" ? "flex-start" : "center",
        justifyContent: "center",
        padding: "0 180px",
        pointerEvents: "none",
      }}
    >
      {heading && (
        <div
          style={{
            fontSize: 42,
            fontWeight: 700,
            fontFamily: "Merriweather, Georgia, serif",
            color: "#e3b58a",
            letterSpacing: "0.04em",
            marginBottom: 48,
            opacity: headingOpacity,
            textAlign: align === "left" ? "left" : "center",
            textShadow: "0 2px 14px rgba(0,0,0,0.6)",
          }}
        >
          {heading}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 28,
          minWidth: 900,
          alignItems: align === "left" ? "flex-start" : "stretch",
        }}
      >
        {items.map((item, i) => {
          const rowFrame = startAt + i * pacing;
          const revealProgress = spring({
            fps,
            frame: Math.max(0, frame - rowFrame),
            config: { damping: 18, stiffness: 90, mass: 1.0 },
            durationInFrames: 30,
          });
          const opacity = revealProgress;
          const x = interpolate(revealProgress, [0, 1], [30, 0]);

          return (
            <div
              key={`${item.key}-${i}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: 64,
                opacity,
                transform: `translateX(${x}px)`,
                padding: "18px 32px",
                borderRadius: 12,
                background: item.accent
                  ? "linear-gradient(90deg, rgba(227,181,138,0.12) 0%, rgba(227,181,138,0.04) 100%)"
                  : "rgba(255,255,255,0.03)",
                borderBottom: `1px solid ${item.accent ? "rgba(227,181,138,0.35)" : "rgba(255,255,255,0.08)"}`,
              }}
            >
              <span
                style={{
                  fontSize: 36,
                  fontWeight: 500,
                  fontFamily: "Inter, system-ui, sans-serif",
                  color: "#8a97ad",
                  letterSpacing: "0.02em",
                  textTransform: "uppercase",
                }}
              >
                {item.key}
              </span>
              <span
                style={{
                  fontSize: 52,
                  fontWeight: 800,
                  fontFamily: item.accent
                    ? "Merriweather, Georgia, serif"
                    : "Inter, system-ui, sans-serif",
                  color: item.accent ? "#f0c89b" : "#f4f7fb",
                  letterSpacing: "-0.01em",
                  textAlign: "right",
                }}
              >
                {item.value}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
