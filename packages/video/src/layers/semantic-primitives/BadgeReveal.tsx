/**
 * badge-reveal (2D) — a text pill that pops in with soft scale + glow.
 * Use for emphasizing a short label or stat within a composable scene.
 *
 * Params:
 *   text:        string — content inside the pill (required)
 *   variant?:    "neutral" | "delta" | "warning" (default neutral)
 *   subtitle?:   string — smaller line below the pill
 *   position?:   "top" | "center" | "bottom" (default center)
 *   fontSize?:   number — CSS px (default 64)
 *   revealAt?:   number — frame when the pill starts to appear (default 5)
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from "remotion";

export interface BadgeRevealProps {
  text?: string;
  variant?: "neutral" | "delta" | "warning";
  subtitle?: string;
  position?: "top" | "center" | "bottom";
  fontSize?: number;
  revealAt?: number;
}

const VARIANTS: Record<string, { bg: string; border: string; fg: string; glow: string }> = {
  neutral: {
    bg: "rgba(244, 234, 219, 0.92)",
    border: "rgba(227, 181, 138, 0.55)",
    fg: "#1a1015",
    glow: "rgba(244, 234, 219, 0.35)",
  },
  delta: {
    bg: "linear-gradient(135deg, #f0c89b 0%, #e3b58a 100%)",
    border: "rgba(255, 255, 255, 0.4)",
    fg: "#1a1015",
    glow: "rgba(240, 200, 155, 0.5)",
  },
  warning: {
    bg: "rgba(45, 25, 20, 0.95)",
    border: "rgba(255, 120, 80, 0.6)",
    fg: "#ffb08a",
    glow: "rgba(255, 120, 80, 0.4)",
  },
};

export const BadgeReveal: React.FC<BadgeRevealProps> = ({
  text = "",
  variant = "neutral",
  subtitle,
  position = "center",
  fontSize = 64,
  revealAt = 5,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({
    fps,
    frame: Math.max(0, frame - revealAt),
    config: { damping: 15, stiffness: 80, mass: 1.2 },
    durationInFrames: 32,
  });

  const styleVariant = VARIANTS[variant] ?? VARIANTS.neutral;

  const justifyContent =
    position === "top" ? "flex-start"
    : position === "bottom" ? "flex-end"
    : "center";

  const paddingTop = position === "top" ? 120 : 0;
  const paddingBottom = position === "bottom" ? 160 : 0;

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
          transform: `scale(${0.75 + enter * 0.25})`,
          opacity: enter,
          display: "inline-flex",
          alignItems: "center",
          padding: `${fontSize * 0.35}px ${fontSize * 0.85}px`,
          background: styleVariant.bg,
          border: `2px solid ${styleVariant.border}`,
          borderRadius: fontSize * 0.8,
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize,
          fontWeight: 800,
          color: styleVariant.fg,
          letterSpacing: "-0.01em",
          boxShadow: `0 12px 48px ${styleVariant.glow}, 0 4px 14px rgba(0,0,0,0.35)`,
        }}
      >
        {text}
      </div>
      {subtitle && (
        <div
          style={{
            marginTop: 22,
            opacity: enter,
            fontSize: Math.round(fontSize * 0.32),
            fontWeight: 600,
            fontFamily: "Inter, system-ui, sans-serif",
            color: "#c8d4e8",
            textAlign: "center",
            maxWidth: 1200,
            textShadow: "0 2px 10px rgba(0,0,0,0.6)",
          }}
        >
          {subtitle}
        </div>
      )}
    </AbsoluteFill>
  );
};
