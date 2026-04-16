import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
} from "remotion";
import { colors, fonts } from "../components/design";
import {
  GlowOrb, breathe,
  SceneBackground, FilmGrain, ScanLine,
  Aurora, Bokeh, LightRays, ConstellationNet, WaveForm, GeometricShapes, Vignette, RippleRings,
  moodForIndex, getMoodColors, type SceneMood,
} from "../motion/generative";

export interface TextTypewriterParams {
  text: string;
  fontSize?: number;
  typingSpeed?: number;
  color?: string;
  accentColor?: string;
  cursorColor?: string;
  subtitle?: string;
  centered?: boolean;
  variation?: number;
  intensity?: number;
  mood?: SceneMood;
}

export const TextTypewriter: React.FC<{
  params?: Partial<TextTypewriterParams>;
  durationInFrames?: number;
}> = ({ params, durationInFrames }) => {
  const frame = useCurrentFrame();
  const text = params?.text ?? "Conversations die. Knowledge shouldn't.";
  const fontSize = params?.fontSize ?? 42;
  const typingSpeed = params?.typingSpeed ?? 1.5;
  const subtitle = params?.subtitle;
  const variation = params?.variation ?? 0;
  const intensity = params?.intensity ?? 0.5;
  const mood = params?.mood ?? moodForIndex(variation);
  const m = getMoodColors(mood);
  const color = params?.color ?? colors.text;
  const accent = params?.accentColor ?? m.accent;

  const charsToShow = Math.min(text.length, Math.floor(frame * typingSpeed));
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

  const bgVariant = variation % 6;

  return (
    <SceneBackground mood={mood} intensity={intensity}>
      {bgVariant === 0 && (
        <>
          <Aurora colors={[accent, m.secondary]} speed={0.008} opacity={0.1} y="25%" />
          <Vignette intensity={0.6} />
        </>
      )}
      {bgVariant === 1 && (
        <>
          <ConstellationNet nodeCount={18} color={accent} seed={`tw-c-${variation}`} speed={0.003} lineOpacity={0.07} />
          <GlowOrb cx="50%" cy="45%" size={200} color={`${accent}15`} pulseSpeed={0.04} />
        </>
      )}
      {bgVariant === 2 && (
        <>
          <WaveForm color={accent} amplitude={25} frequency={0.025} speed={0.03} y="65%" opacity={0.12} layers={4} />
          <WaveForm color={m.secondary} amplitude={20} frequency={0.03} speed={0.025} y="35%" opacity={0.08} layers={2} />
        </>
      )}
      {bgVariant === 3 && (
        <>
          <Bokeh count={10} colors={[accent, m.secondary, `${accent}80`]} seed={`tw-b-${variation}`} minSize={50} maxSize={180} speed={0.004} />
          <Vignette intensity={0.5} />
        </>
      )}
      {bgVariant === 4 && (
        <>
          <LightRays count={6} color={accent} originX="70%" originY="0%" spread={35} opacity={0.035} />
          <GeometricShapes count={6} color={m.secondary} seed={`tw-g-${variation}`} opacity={0.05} />
        </>
      )}
      {bgVariant === 5 && (
        <>
          <RippleRings cx="50%" cy="50%" color={accent} count={5} speed={0.4} maxRadius={350} opacity={0.06} />
          <GlowOrb cx="50%" cy="50%" size={160} color={`${accent}20`} pulseSpeed={0.05} />
          <Vignette intensity={0.55} />
        </>
      )}

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
      <ScanLine color={accent} speed={0.3} opacity={0.02} />
      <FilmGrain intensity={0.03} />
    </SceneBackground>
  );
};
