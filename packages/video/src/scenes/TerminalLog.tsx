import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
} from "remotion";
import { colors, fonts } from "../components/design";
import {
  breathe,
  SceneBackground, ScanLine, FilmGrain,
  ConstellationNet, WaveForm, Vignette, GradientWash,
  type SceneMood,
} from "../motion/generative";

interface LogLine {
  text: string;
  color?: string;
  delay?: number;
}

export interface TerminalLogParams {
  lines: LogLine[];
  prompt?: string;
  accentColor?: string;
  typingSpeed?: number;
  mood?: SceneMood;
}

const DEFAULT_LINES: LogLine[] = [
  { text: "→ scout: researching competitor pricing...", color: "#3b82f6" },
  { text: "  found 3 changes in the last 24h", color: "#71717a" },
  { text: "→ scribe: drafting weekly recap...", color: "#22c55e" },
  { text: "  1,200 words. tone: conversational. scheduled for 9am.", color: "#71717a" },
  { text: "→ sentinel: monitoring uptime...", color: "#a855f7" },
  { text: "  all systems nominal. 99.98% over 30d.", color: "#71717a" },
  { text: "→ broker: 2 new leads responded", color: "#f97316" },
  { text: "  follow-ups queued for tomorrow morning.", color: "#71717a" },
];

export const TerminalLog: React.FC<{
  params?: Partial<TerminalLogParams>;
  durationInFrames?: number;
}> = ({ params }) => {
  const frame = useCurrentFrame();
  const lines = params?.lines?.length ? params.lines : DEFAULT_LINES;
  const prompt = params?.prompt ?? "ohwow";
  const accent = params?.accentColor ?? "#818cf8";
  const typingSpeed = params?.typingSpeed ?? 2;
  const mood = params?.mood ?? 'midnight';

  const headerFade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });

  return (
    <SceneBackground mood={mood} intensity={0.6}>
      <ConstellationNet nodeCount={12} color={accent} seed="term-net" speed={0.002} lineOpacity={0.04} dotSize={2} />
      <WaveForm color={accent} amplitude={15} frequency={0.015} speed={0.02} y="85%" opacity={0.06} layers={2} />
      <GradientWash colors={[accent, '#22d3ee']} speed={0.003} angle={160} opacity={0.04} />

      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: `translate(-50%, -50%) scale(${breathe(frame, 0.02, 0.005)})`,
          width: 800,
          maxHeight: 500,
          background: "rgba(5, 5, 16, 0.94)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: `0 0 60px rgba(0,0,0,0.5), 0 0 40px ${accent}08`,
        }}
      >
        <div
          style={{
            height: 36,
            background: "rgba(255,255,255,0.04)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            alignItems: "center",
            padding: "0 14px",
            gap: 8,
            opacity: headerFade,
          }}
        >
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#febc2e" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840" }} />
          <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, marginLeft: 12 }}>
            {prompt}
          </span>
        </div>

        <div style={{ padding: "16px 20px", fontFamily: fonts.mono, fontSize: 13, lineHeight: 1.8 }}>
          {lines.map((line, i) => {
            const lineDelay = line.delay ?? (12 + i * 12);
            const localFrame = frame - lineDelay;
            if (localFrame < 0) return null;

            const chars = Math.min(line.text.length, Math.floor(localFrame * typingSpeed));
            const lineOpacity = interpolate(localFrame, [0, 5], [0, 1], { extrapolateRight: "clamp" });
            const lineColor = line.color ?? colors.text;

            return (
              <div key={i} style={{ opacity: lineOpacity, color: lineColor }}>
                {line.text.slice(0, chars)}
                {chars < line.text.length && (
                  <span style={{ color: accent, opacity: Math.floor(frame * 0.08) % 2 === 0 ? 1 : 0 }}>▋</span>
                )}
              </div>
            );
          })}

          {(() => {
            const lastLineDelay = (lines[lines.length - 1]?.delay ?? (12 + (lines.length - 1) * 12));
            const lastLineChars = lines[lines.length - 1]?.text.length ?? 0;
            const cursorStart = lastLineDelay + lastLineChars / typingSpeed + 10;
            if (frame < cursorStart) return null;
            const blink = Math.floor(frame * 0.06) % 2 === 0;
            return (
              <div style={{ marginTop: 4 }}>
                <span style={{ color: accent }}>$ </span>
                <span style={{ color: accent, opacity: blink ? 1 : 0 }}>▋</span>
              </div>
            );
          })()}
        </div>
      </div>

      <ScanLine color={accent} speed={0.5} opacity={0.04} />
      <Vignette intensity={0.5} />
      <FilmGrain intensity={0.05} />
    </SceneBackground>
  );
};
