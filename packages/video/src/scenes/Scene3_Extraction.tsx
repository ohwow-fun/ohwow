/**
 * Scene 3: The Extraction (frames 0-330)
 * Voice: "Every decision you made. Every pattern you noticed.
 *         Every lesson you learned the hard way. Extracted. Structured. Yours." (10s)
 */

import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { noise2D } from "@remotion/noise";
import { colors, fonts } from "../components/design";
import { GlassCard } from "../components/GlassCard";
import { Counter } from "../components/Counter";
import { Caption } from "../components/Caption";

const cards = [
  { type: "Decision", text: "Postgres over MongoDB for transactional data", delay: 100 },
  { type: "Fact", text: "Users churn when onboarding exceeds 3 steps", delay: 140 },
  { type: "Procedure", text: "Always run migrations before deploy", delay: 180 },
  { type: "Insight", text: "The pricing page converts better without a free tier", delay: 220 },
];

const Particles: React.FC<{ frame: number }> = ({ frame }) => {
  const particles = Array.from({ length: 20 }, (_, i) => i);
  return (
    <>
      {particles.map((i) => {
        const speed = 2 + (i % 5) * 0.5;
        const progress = ((frame * speed + i * 30) % 500) / 500;
        const x = interpolate(progress, [0, 0.4, 0.6, 1], [-400, -20, 20, 400]);
        const y = noise2D(`p-${i}`, progress * 3, 0) * 30;
        const opacity = progress < 0.1 ? progress * 10 : progress > 0.9 ? (1 - progress) * 10 : 0.6;
        const size = 3 + (i % 3);
        return (
          <div key={i} style={{
            position: "absolute",
            left: `calc(50% + ${x}px)`, top: `calc(45% + ${y}px)`,
            width: size, height: size, borderRadius: "50%",
            background: progress < 0.5 ? colors.blue : colors.accent,
            opacity, boxShadow: `0 0 ${size * 2}px ${progress < 0.5 ? colors.blue : colors.accent}60`,
          }} />
        );
      })}
    </>
  );
};

export const Scene3: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const orbPulse = 1 + Math.sin(frame * 0.08) * 0.1;
  const orbOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <Particles frame={frame} />

      {/* Processing orb */}
      <div style={{
        position: "absolute", left: "calc(50% - 30px)", top: "calc(45% - 30px)",
        width: 60, height: 60, borderRadius: "50%",
        background: `radial-gradient(circle, ${colors.accent}60 0%, ${colors.accent}10 50%, transparent 70%)`,
        transform: `scale(${orbPulse})`, opacity: orbOpacity,
        boxShadow: `0 0 80px ${colors.accentGlow}`,
      }} />

      {/* Knowledge cards */}
      <div style={{ position: "absolute", right: 60, top: 80, display: "flex", flexDirection: "column", gap: 12 }}>
        {cards.map((card) => (
          <GlassCard key={card.type} type={card.type} text={card.text} enterFrame={card.delay} width={360} />
        ))}
      </div>

      {/* Counter */}
      <div style={{ position: "absolute", left: 60, bottom: 120 }}>
        <Counter from={0} to={127} startFrame={220} durationFrames={60} label="memories extracted" />
      </div>

      {/* Captions synced to voice: 10s total */}
      <Caption text="Every decision you made. Every pattern you noticed." highlight={["decision", "pattern"]} startFrame={0} durationFrames={120} />
      <Caption text="Every lesson you learned the hard way." highlight={["lesson"]} startFrame={125} durationFrames={90} />
      <Caption text="Extracted. Structured. Yours." highlight={["Yours."]} startFrame={230} durationFrames={90} />
    </AbsoluteFill>
  );
};
