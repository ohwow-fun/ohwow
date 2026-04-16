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
      <NoiseGrid cols={20} rows={12} cellSize={64} seed="typewriter" color={accent} speed={0.003} />
      <GlowOrb cx="50%" cy="45%" size={200} color={accent} pulseSpeed={0.04} />

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
