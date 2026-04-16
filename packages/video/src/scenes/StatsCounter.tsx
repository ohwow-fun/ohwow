/**
 * Scene: Stats Counter — dramatic animated number reveals with
 * a generative flow-field background and pulse rings.
 *
 * Each counter (2-4) animates from 0 to its target value with a
 * spring-driven ease. The flow field and pulse rings create organic
 * motion behind the numbers.
 */

import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { colors, fonts } from "../components/design";
import { FlowFieldLayer, PulseRing, breathe, shimmer, SceneBackground, FilmGrain, type SceneMood } from "../motion/generative";

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
  { to: 33, label: "agents", color: colors.accent },
  { to: 188, label: "tasks completed", color: colors.blue },
  { to: 433, label: "memories", color: colors.green },
];

export const StatsCounter: React.FC<{
  params?: Partial<StatsCounterParams>;
  durationInFrames?: number;
}> = ({ params }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const counters = params?.counters?.length ? params.counters : DEFAULT_COUNTERS;
  const layout = params?.layout ?? "row";
  const accent = params?.accentColor ?? colors.accent;
  const particleCount = params?.particleCount ?? 25;

  const isGrid = layout === "grid" && counters.length > 2;
  const gridCols = isGrid ? Math.min(counters.length, 3) : counters.length;

  const mood = params?.mood ?? 'cool';

  return (
    <SceneBackground mood={mood} intensity={0.6}>
      <FlowFieldLayer
        count={particleCount}
        seed="stats"
        speed={0.6}
        colors={[accent, colors.blue, colors.green]}
      />
      <PulseRing cx="50%" cy="45%" radius={250} color={accent} speed={0.04} />
      <PulseRing cx="50%" cy="45%" radius={320} color={`${accent}60`} speed={0.03} />

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
      <FilmGrain intensity={0.03} />
    </SceneBackground>
  );
};
