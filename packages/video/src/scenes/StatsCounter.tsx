import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { colors, fonts } from "../components/design";
import {
  breathe, shimmer,
  SceneBackground, FilmGrain,
  WaveForm, Bokeh, RippleRings, GlowOrb, Vignette,
  getMoodColors, type SceneMood,
} from "../motion/generative";

interface CounterItem {
  to: number;
  label: string;
  startFrame?: number;
  color?: string;
  prefix?: string;
  suffix?: string;
}

export interface StatsCounterParams {
  counters: CounterItem[];
  layout?: "row" | "grid";
  accentColor?: string;
  particleCount?: number;
  mood?: SceneMood;
}

const DEFAULT_COUNTERS: CounterItem[] = [
  { to: 33, label: "agents", color: "#f97316" },
  { to: 188, label: "tasks completed", color: "#3b82f6" },
  { to: 433, label: "memories", color: "#22c55e" },
];

export const StatsCounter: React.FC<{
  params?: Partial<StatsCounterParams>;
  durationInFrames?: number;
}> = ({ params }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const counters = params?.counters?.length ? params.counters : DEFAULT_COUNTERS;
  const layout = params?.layout ?? "row";
  const mood = params?.mood ?? 'cool';
  const m = getMoodColors(mood);
  const accent = params?.accentColor ?? m.accent;

  const isGrid = layout === "grid" && counters.length > 2;
  const gridCols = isGrid ? Math.min(counters.length, 3) : counters.length;

  return (
    <SceneBackground mood={mood} intensity={0.6}>
      <WaveForm color={accent} amplitude={20} frequency={0.02} speed={0.025} y="75%" opacity={0.1} layers={3} />
      <WaveForm color={m.secondary} amplitude={15} frequency={0.025} speed={0.02} y="25%" opacity={0.06} layers={2} />
      <Bokeh count={8} colors={[accent, m.secondary]} seed="stats-bokeh" minSize={40} maxSize={120} speed={0.003} />
      <RippleRings cx="50%" cy="45%" color={accent} count={3} speed={0.3} maxRadius={300} opacity={0.05} />
      <GlowOrb cx="50%" cy="45%" size={180} color={`${accent}15`} pulseSpeed={0.04} />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexWrap: isGrid ? "wrap" : "nowrap",
          justifyContent: "center",
          alignItems: "center",
          gap: isGrid ? 40 : 60,
          padding: 40,
        }}
      >
        {counters.map((counter, i) => {
          const start = counter.startFrame ?? i * 20 + 15;
          const localFrame = frame - start;
          if (localFrame < 0) return <div key={i} style={{ width: isGrid ? `${100 / gridCols - 5}%` : 200, height: 140 }} />;

          const enter = spring({ fps, frame: localFrame, config: { damping: 25, stiffness: 70 }, durationInFrames: 20 });
          const countProgress = Math.min(1, localFrame / 40);
          const currentValue = Math.round(counter.to * countProgress);
          const scale = breathe(frame, 0.05 + i * 0.01, 0.02);
          const glowIntensity = shimmer(frame, i, 0.03, 0.5);
          const color = counter.color ?? accent;

          return (
            <div
              key={i}
              style={{
                opacity: enter,
                transform: `scale(${enter * scale}) translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
                textAlign: "center",
                width: isGrid ? `${100 / gridCols - 5}%` : undefined,
                minWidth: 160,
              }}
            >
              <div
                style={{
                  fontFamily: fonts.display,
                  fontSize: 72,
                  fontWeight: 700,
                  color,
                  lineHeight: 1,
                  textShadow: glowIntensity > 0.2
                    ? `0 0 ${30 * glowIntensity}px ${color}60`
                    : "none",
                }}
              >
                {counter.prefix ?? ""}{currentValue.toLocaleString()}{counter.suffix ?? ""}
              </div>
              <div
                style={{
                  fontFamily: fonts.sans,
                  fontSize: 16,
                  color: colors.textMuted,
                  marginTop: 8,
                  opacity: interpolate(localFrame, [10, 25], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
                }}
              >
                {counter.label}
              </div>
            </div>
          );
        })}
      </div>
      <Vignette intensity={0.5} />
      <FilmGrain intensity={0.03} />
    </SceneBackground>
  );
};
