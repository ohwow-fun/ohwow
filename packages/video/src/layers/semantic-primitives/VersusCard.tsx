/**
 * versus-card (2D) — before/after comparison. Lighter-weight than the
 * r3f.versus-cards primitive for scenes that want the semantic
 * comparison without a full 3D treatment.
 *
 * Params:
 *   before:  { label: string, value?: string }
 *   after:   { label: string, value?: string }
 *   label?:  string — metric name above both cards
 *   transitionAt?: number — frame the crossfade begins (default 20)
 *   transitionDuration?: number — frames for the crossfade (default 60)
 *   accent?: string — divider glow color (default warm gold #e3b58a)
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { asmrEasing } from "../../motion/asmr";

export interface VersusCardProps {
  before?: { label: string; value?: string };
  after?: { label: string; value?: string };
  label?: string;
  transitionAt?: number;
  transitionDuration?: number;
  accent?: string;
}

export const VersusCard: React.FC<VersusCardProps> = ({
  before = { label: "Before" },
  after = { label: "After" },
  label,
  transitionAt = 20,
  transitionDuration = 60,
  accent = "#e3b58a",
}) => {
  const frame = useCurrentFrame();

  const afterBrightness = interpolate(
    frame,
    [transitionAt, transitionAt + transitionDuration],
    [0.35, 1.0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: asmrEasing },
  );
  const beforeBrightness = interpolate(
    frame,
    [transitionAt, transitionAt + transitionDuration],
    [1.0, 0.3],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: asmrEasing },
  );

  const cardWidth = 440;
  const cardHeight = 520;

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      {label && (
        <div
          style={{
            fontSize: 36,
            fontWeight: 700,
            color: accent,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            marginBottom: 30,
            textShadow: "0 2px 10px rgba(0,0,0,0.6)",
          }}
        >
          {label}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Before card */}
        <div
          style={{
            width: cardWidth,
            height: cardHeight,
            background: `rgba(30, 35, 46, ${0.6 + beforeBrightness * 0.2})`,
            border: `2px solid rgba(255, 255, 255, ${beforeBrightness * 0.2})`,
            borderRadius: 20,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "48px 32px",
            opacity: 0.5 + beforeBrightness * 0.5,
            boxShadow: `0 10px 40px rgba(0,0,0,0.5)`,
          }}
        >
          {before.value && (
            <div
              style={{
                fontSize: 140,
                fontWeight: 900,
                fontFamily: "Merriweather, Georgia, serif",
                color: "#c8d4e8",
                lineHeight: 1,
                letterSpacing: "-0.02em",
              }}
            >
              {before.value}
            </div>
          )}
          <div
            style={{
              marginTop: 18,
              fontSize: 28,
              fontWeight: 500,
              color: "#8a97ad",
              textAlign: "center",
            }}
          >
            {before.label}
          </div>
        </div>

        {/* Divider */}
        <div
          style={{
            width: 4,
            height: cardHeight - 40,
            background: accent,
            boxShadow: `0 0 20px ${accent}, 0 0 40px ${accent}`,
            borderRadius: 2,
            margin: "0 20px",
          }}
        />

        {/* After card */}
        <div
          style={{
            width: cardWidth,
            height: cardHeight,
            background: `linear-gradient(135deg, rgba(240, 200, 155, ${0.2 + afterBrightness * 0.2}) 0%, rgba(227, 181, 138, ${0.15 + afterBrightness * 0.15}) 100%)`,
            border: `2px solid rgba(227, 181, 138, ${afterBrightness * 0.7})`,
            borderRadius: 20,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "48px 32px",
            opacity: 0.5 + afterBrightness * 0.5,
            boxShadow: `0 10px 50px rgba(227, 181, 138, ${afterBrightness * 0.35}), 0 10px 40px rgba(0,0,0,0.4)`,
          }}
        >
          {after.value && (
            <div
              style={{
                fontSize: 140,
                fontWeight: 900,
                fontFamily: "Merriweather, Georgia, serif",
                color: "#fff4e6",
                lineHeight: 1,
                letterSpacing: "-0.02em",
                textShadow: `0 2px 20px rgba(227, 181, 138, ${afterBrightness * 0.6})`,
              }}
            >
              {after.value}
            </div>
          )}
          <div
            style={{
              marginTop: 18,
              fontSize: 28,
              fontWeight: 500,
              color: "#f0c89b",
              textAlign: "center",
            }}
          >
            {after.label}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
