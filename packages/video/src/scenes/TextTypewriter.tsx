/**
 * Scene: Text Typewriter — a single powerful sentence typing itself
 * onto a dark screen with a noise grid background and cursor blink.
 *
 * Perfect for dramatic openings, closings, or quote moments.
 * Uses generative noise grid for subtle background life.
 */

import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
} from "remotion";
import { colors, fonts } from "../components/design";
import { NoiseGrid, GlowOrb, breathe } from "../motion/generative";

export interface TextTypewriterParams {
  text: string;
  fontSize?: number;
  typingSpeed?: number;
  color?: string;
  accentColor?: string;
  cursorColor?: string;
  subtitle?: string;
  centered?: boolean;
  /** Visual variation index — shifts noise seed, orb position, grid density. */
  variation?: number;
  /** Intensity 0-1: controls glow size, particle count, grid opacity. */
  intensity?: number;
}

export const TextTypewriter: React.FC<{
  params?: Partial<TextTypewriterParams>;
  durationInFrames?: number;
}> = ({ params, durationInFrames }) => {
  const frame = useCurrentFrame();
  const text = params?.text ?? "Conversations die. Knowledge shouldn't.";
  const fontSize = params?.fontSize ?? 42;
  const typingSpeed = params?.typingSpeed ?? 1.5;
  const color = params?.color ?? colors.text;
  const accent = params?.accentColor ?? colors.accent;
  const subtitle = params?.subtitle;
  const variation = params?.variation ?? 0;
  const intensity = params?.intensity ?? 0.5;

  const orbPositions = [
    { cx: '50%', cy: '45%' },
    { cx: '30%', cy: '55%' },
    { cx: '70%', cy: '40%' },
    { cx: '45%', cy: '60%' },
    { cx: '55%', cy: '35%' },
  ];
  const orbPos = orbPositions[variation % orbPositions.length];
  const orbSize = 120 + intensity * 160;
  const gridDensity = Math.round(14 + intensity * 10);

  const charsToShow = Math.min(
    text.length,
    Math.floor(frame * typingSpeed),
  );
  const typed = text.slice(0, charsToShow);
  const isTyping = charsToShow < text.length;
  const cursorVisible = isTyping || (Math.floor(frame * 0.06) % 2 === 0);

  const dur = durationInFrames ?? 180;
  const fadeIn = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  const subtitleFade = subtitle
    ? interpolate(frame, [Math.min(dur - 60, text.length / typingSpeed + 15), Math.min(dur - 40, text.length / typingSpeed + 30)], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 0;

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <NoiseGrid cols={gridDensity} rows={Math.round(gridDensity * 0.56)} cellSize={64} seed={`tw-${variation}`} color={accent} speed={0.003 + variation * 0.001} />
      <GlowOrb cx={orbPos.cx} cy={orbPos.cy} size={orbSize} color={accent} pulseSpeed={0.04 + variation * 0.005} />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: params?.centered !== false ? "center" : "flex-start",
          padding: "0 120px",
          opacity: fadeIn,
        }}
      >
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize,
            fontWeight: 600,
            color,
            lineHeight: 1.3,
            maxWidth: 900,
            textAlign: params?.centered !== false ? "center" : "left",
            transform: `scale(${breathe(frame, 0.03, 0.008)})`,
          }}
        >
          {typed}
          {cursorVisible && (
            <span style={{ color: params?.cursorColor ?? accent, fontWeight: 300 }}>▍</span>
          )}
        </div>
        {subtitle && subtitleFade > 0 && (
          <div
            style={{
              fontFamily: fonts.sans,
              fontSize: 18,
              color: colors.textMuted,
              marginTop: 20,
              opacity: subtitleFade,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
