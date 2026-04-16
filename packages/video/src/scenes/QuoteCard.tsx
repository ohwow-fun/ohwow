import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
} from "remotion";
import { colors, fonts } from "../components/design";
import { NoiseGrid, GlowOrb, PulseRing, FlowFieldLayer, breathe } from "../motion/generative";

export interface QuoteCardParams {
  quote: string;
  attribution?: string;
  accentColor?: string;
  fontSize?: number;
  variation?: number;
}

export const QuoteCard: React.FC<{
  params?: Partial<QuoteCardParams>;
  durationInFrames?: number;
}> = ({ params, durationInFrames }) => {
  const frame = useCurrentFrame();
  const quote = params?.quote ?? "What would you build if you never had to follow up again?";
  const attribution = params?.attribution;
  const accent = params?.accentColor ?? colors.accent;
  const fontSize = params?.fontSize ?? (quote.length > 80 ? 32 : quote.length > 50 ? 38 : 46);
  const variation = params?.variation ?? 0;
  const dur = durationInFrames ?? 180;

  const orbPositions = [
    { cx: "50%", cy: "50%" },
    { cx: "35%", cy: "45%" },
    { cx: "65%", cy: "55%" },
    { cx: "40%", cy: "60%" },
  ];
  const orbPos = orbPositions[variation % orbPositions.length];

  const fadeIn = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const quoteMarkFade = interpolate(frame, [5, 25], [0, 0.12], { extrapolateRight: "clamp" });
  const textReveal = interpolate(frame, [10, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const attrFade = attribution
    ? interpolate(frame, [Math.min(dur - 50, 50), Math.min(dur - 30, 70)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 0;

  const words = quote.split(" ");
  const visibleWords = Math.ceil(words.length * textReveal);

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <NoiseGrid cols={12} rows={7} cellSize={100} seed={`quote-${variation}`} color={accent} speed={0.002} />
      <GlowOrb cx={orbPos.cx} cy={orbPos.cy} size={300 + variation * 30} color={`${accent}25`} pulseSpeed={0.03} />
      <PulseRing cx="50%" cy="50%" radius={350} color={`${accent}15`} speed={0.025} />
      <FlowFieldLayer count={10} seed={`quote-flow-${variation}`} speed={0.3} colors={[accent, colors.purple]} />

      {/* Giant quotation mark */}
      <div
        style={{
          position: "absolute",
          top: "20%",
          left: "10%",
          fontFamily: fonts.display,
          fontSize: 300,
          color: accent,
          opacity: quoteMarkFade,
          lineHeight: 1,
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {"\u201C"}
      </div>

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          padding: "0 100px",
          opacity: fadeIn,
        }}
      >
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize,
            fontWeight: 600,
            color: colors.text,
            lineHeight: 1.35,
            textAlign: "center",
            maxWidth: 900,
            transform: `scale(${breathe(frame, 0.025, 0.006)})`,
          }}
        >
          {words.slice(0, visibleWords).join(" ")}
          {visibleWords < words.length && (
            <span style={{ color: accent, opacity: 0.6 }}> ...</span>
          )}
        </div>

        {attribution && attrFade > 0 && (
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 14,
              color: colors.textMuted,
              marginTop: 24,
              opacity: attrFade,
              letterSpacing: 1,
            }}
          >
            — {attribution}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
