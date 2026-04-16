import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
} from "remotion";
import { colors, fonts } from "../components/design";
import {
  GlowOrb, breathe,
  SceneBackground, FilmGrain, Aurora, Bokeh, LightRays, ConstellationNet, Vignette,
  moodForIndex, getMoodColors, type SceneMood,
} from "../motion/generative";

export interface QuoteCardParams {
  quote: string;
  attribution?: string;
  accentColor?: string;
  fontSize?: number;
  variation?: number;
  mood?: SceneMood;
}

export const QuoteCard: React.FC<{
  params?: Partial<QuoteCardParams>;
  durationInFrames?: number;
}> = ({ params, durationInFrames }) => {
  const frame = useCurrentFrame();
  const quote = params?.quote ?? "What would you build if you never had to follow up again?";
  const attribution = params?.attribution;
  const variation = params?.variation ?? 0;
  const mood = params?.mood ?? moodForIndex(variation);
  const m = getMoodColors(mood);
  const accent = params?.accentColor ?? m.accent;
  const fontSize = params?.fontSize ?? (quote.length > 80 ? 32 : quote.length > 50 ? 38 : 46);
  const dur = durationInFrames ?? 180;

  const fadeIn = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const quoteMarkFade = interpolate(frame, [5, 25], [0, 0.12], { extrapolateRight: "clamp" });
  const textReveal = interpolate(frame, [10, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const attrFade = attribution
    ? interpolate(frame, [Math.min(dur - 50, 50), Math.min(dur - 30, 70)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 0;

  const words = quote.split(" ");
  const visibleWords = Math.ceil(words.length * textReveal);

  const bgVariant = variation % 4;

  return (
    <SceneBackground mood={mood} intensity={0.7}>
      {/* Each variation gets a different primitive combination */}
      {bgVariant === 0 && <Aurora colors={[accent, m.secondary, `${accent}80`]} speed={0.006} opacity={0.12} />}
      {bgVariant === 1 && <LightRays count={7} color={accent} originX="30%" spread={50} opacity={0.03} />}
      {bgVariant === 2 && <ConstellationNet nodeCount={15} color={m.secondary} seed={`q-${variation}`} lineOpacity={0.06} />}
      {bgVariant === 3 && <Bokeh count={8} colors={[accent, m.secondary]} seed={`qb-${variation}`} minSize={40} maxSize={150} />}

      <GlowOrb cx="50%" cy="45%" size={280 + variation * 40} color={`${accent}18`} pulseSpeed={0.03} />
      <Vignette intensity={0.5} />

      <div
        style={{
          position: "absolute",
          top: "18%",
          left: "8%",
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
      <FilmGrain intensity={0.03} />
    </SceneBackground>
  );
};
