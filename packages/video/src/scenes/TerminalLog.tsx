import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
} from "remotion";
import { colors, fonts } from "../components/design";
import { NoiseGrid, FlowFieldLayer, breathe } from "../motion/generative";

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
}

const DEFAULT_LINES: LogLine[] = [
  { text: "→ scout: researching competitor pricing...", color: colors.blue },
  { text: "  found 3 changes in the last 24h", color: colors.textMuted },
  { text: "→ scribe: drafting weekly recap...", color: colors.green },
  { text: "  1,200 words. tone: conversational. scheduled for 9am.", color: colors.textMuted },
  { text: "→ sentinel: monitoring uptime...", color: colors.purple },
  { text: "  all systems nominal. 99.98% over 30d.", color: colors.textMuted },
  { text: "→ broker: 2 new leads responded", color: colors.accent },
  { text: "  follow-ups queued for tomorrow morning.", color: colors.textMuted },
];

export const TerminalLog: React.FC<{
  params?: Partial<TerminalLogParams>;
  durationInFrames?: number;
}> = ({ params }) => {
  const frame = useCurrentFrame();
  const lines = params?.lines?.length ? params.lines : DEFAULT_LINES;
  const prompt = params?.prompt ?? "ohwow";
  const accent = params?.accentColor ?? colors.accent;
  const typingSpeed = params?.typingSpeed ?? 2;

  const headerFade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <NoiseGrid cols={20} rows={12} cellSize={64} seed="term" color={accent} speed={0.002} />
      <FlowFieldLayer count={12} seed="term-flow" speed={0.3} colors={[accent, colors.blue]} />

      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: `translate(-50%, -50%) scale(${breathe(frame, 0.02, 0.005)})`,
          width: 800,
          maxHeight: 500,
          background: "rgba(10, 10, 18, 0.92)",
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: `0 0 60px rgba(0,0,0,0.5), 0 0 30px ${accent}10`,
        }}
      >
        <div
          style={{
            height: 36,
            background: "rgba(255,255,255,0.04)",
            borderBottom: `1px solid ${colors.cardBorder}`,
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
    </AbsoluteFill>
  );
};
