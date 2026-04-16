import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { colors, fonts, glass } from "../components/design";
import { NoiseGrid, GlowOrb, FlowFieldLayer, breathe, shimmer } from "../motion/generative";

interface SideItem {
  text: string;
  icon?: string;
}

export interface BeforeAfterParams {
  before: { label?: string; items: SideItem[] };
  after: { label?: string; items: SideItem[] };
  splitFrame?: number;
  accentColor?: string;
}

const DEFAULT_BEFORE: SideItem[] = [
  { text: "Checking 5 apps before coffee", icon: "😫" },
  { text: "Copy-pasting between tools", icon: "📋" },
  { text: "Forgetting to follow up", icon: "🕳️" },
  { text: "Working weekends", icon: "😓" },
];

const DEFAULT_AFTER: SideItem[] = [
  { text: "Agents already handled it", icon: "✨" },
  { text: "Everything flows together", icon: "🔗" },
  { text: "Nothing falls through", icon: "🎯" },
  { text: "Friday off. Nothing breaks.", icon: "🏖️" },
];

export const BeforeAfter: React.FC<{
  params?: Partial<BeforeAfterParams>;
  durationInFrames?: number;
}> = ({ params, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dur = durationInFrames ?? 180;

  const beforeItems = params?.before?.items?.length ? params.before.items : DEFAULT_BEFORE;
  const afterItems = params?.after?.items?.length ? params.after.items : DEFAULT_AFTER;
  const beforeLabel = params?.before?.label ?? "before";
  const afterLabel = params?.after?.label ?? "after";
  const splitFrame = params?.splitFrame ?? Math.round(dur * 0.4);
  const accent = params?.accentColor ?? colors.accent;

  const dividerProgress = interpolate(frame, [splitFrame - 10, splitFrame + 5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const afterRevealed = frame >= splitFrame;

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <NoiseGrid cols={16} rows={9} cellSize={80} seed="ba" color={afterRevealed ? accent : "#ef4444"} speed={0.003} />

      {afterRevealed && (
        <GlowOrb cx="75%" cy="50%" size={250} color={`${accent}40`} pulseSpeed={0.05} />
      )}

      <FlowFieldLayer
        count={15}
        seed="ba-flow"
        speed={0.5}
        colors={afterRevealed ? [accent, colors.green, colors.blue] : ["#ef4444", "#f97316", colors.textMuted]}
      />

      <div style={{ position: "absolute", inset: 0, display: "flex" }}>
        {/* Before side */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 50px" }}>
          <div
            style={{
              fontFamily: fonts.display,
              fontSize: 20,
              color: "#ef4444",
              textTransform: "uppercase",
              letterSpacing: 4,
              marginBottom: 24,
              opacity: interpolate(frame, [5, 15], [0, 1], { extrapolateRight: "clamp" }),
            }}
          >
            {beforeLabel}
          </div>
          {beforeItems.slice(0, 5).map((item, i) => {
            const delay = 10 + i * 14;
            const localFrame = frame - delay;
            if (localFrame < 0) return <div key={i} style={{ height: 52 }} />;
            const enter = spring({ fps, frame: localFrame, config: { damping: 25 }, durationInFrames: 14 });
            const strikethrough = afterRevealed
              ? interpolate(frame, [splitFrame + i * 6, splitFrame + i * 6 + 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
              : 0;

            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 12,
                  opacity: enter * (afterRevealed ? 0.4 + (1 - strikethrough) * 0.6 : 1),
                  transform: `translateX(${interpolate(enter, [0, 1], [-30, 0])}px)`,
                }}
              >
                <span style={{ fontSize: 20, flexShrink: 0 }}>{item.icon ?? "•"}</span>
                <span
                  style={{
                    fontFamily: fonts.sans,
                    fontSize: 16,
                    color: colors.text,
                    textDecoration: strikethrough > 0.5 ? "line-through" : "none",
                    textDecorationColor: "#ef444480",
                  }}
                >
                  {item.text}
                </span>
              </div>
            );
          })}
        </div>

        {/* Divider */}
        <div
          style={{
            width: 2,
            background: `linear-gradient(transparent, ${accent}60, transparent)`,
            opacity: dividerProgress,
            transform: `scaleY(${dividerProgress})`,
          }}
        />

        {/* After side */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 50px" }}>
          {afterRevealed && (
            <>
              <div
                style={{
                  fontFamily: fonts.display,
                  fontSize: 20,
                  color: accent,
                  textTransform: "uppercase",
                  letterSpacing: 4,
                  marginBottom: 24,
                  opacity: interpolate(frame, [splitFrame, splitFrame + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
                }}
              >
                {afterLabel}
              </div>
              {afterItems.slice(0, 5).map((item, i) => {
                const delay = splitFrame + 8 + i * 14;
                const localFrame = frame - delay;
                if (localFrame < 0) return <div key={i} style={{ height: 52 }} />;
                const enter = spring({ fps, frame: localFrame, config: { damping: 22, stiffness: 90 }, durationInFrames: 14 });
                const glow = shimmer(frame, i, 0.03, 0.5);

                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 12,
                      opacity: enter,
                      transform: `translateX(${interpolate(enter, [0, 1], [30, 0])}px) scale(${breathe(frame, 0.03, 0.008)})`,
                    }}
                  >
                    <span style={{ fontSize: 20, flexShrink: 0 }}>{item.icon ?? "✓"}</span>
                    <span
                      style={{
                        fontFamily: fonts.sans,
                        fontSize: 16,
                        color: colors.text,
                        textShadow: glow > 0.3 ? `0 0 ${12 * glow}px ${accent}40` : "none",
                      }}
                    >
                      {item.text}
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};
