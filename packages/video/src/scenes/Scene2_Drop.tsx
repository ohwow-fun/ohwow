/**
 * Scene: The Drop — files absorbing into a glowing ring.
 *
 * Parametrized: pass `params.files[]` to override the sources (e.g., real
 * integrations from the user's workspace: WhatsApp, X, GitHub, etc.) and
 * `params.counters[]` to override the metric counters beneath the ring.
 */

import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { colors, fonts, glass } from "../components/design";
import { Counter } from "../components/Counter";
import type { DropParams } from "../spec/kinds";

const DEFAULT_FILES: NonNullable<DropParams['files']> = [
  { name: "conversations.json", source: "ChatGPT", color: colors.chatgpt, delay: 0 },
  { name: "claude-export.json", source: "Claude", color: colors.claude, delay: 15 },
  { name: "chats.json", source: "Gemini", color: colors.gemini, delay: 30 },
];

const DEFAULT_COUNTERS: NonNullable<DropParams['counters']> = [
  { to: 214, label: "conversations", startFrame: 40 },
  { to: 4891, label: "messages",      startFrame: 50 },
];

export const Scene2: React.FC<{ params?: Partial<DropParams> }> = ({ params }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const files = params?.files?.length ? params.files : DEFAULT_FILES;
  const counters = params?.counters?.length ? params.counters : DEFAULT_COUNTERS;

  return (
    <AbsoluteFill style={{ background: colors.bg, justifyContent: "center", alignItems: "center" }}>
      {/* Drop zone ring */}
      <div
        style={{
          position: "absolute",
          width: 200, height: 200, borderRadius: "50%",
          border: `2px solid ${colors.accent}30`,
          boxShadow: `0 0 60px ${colors.accentGlow}, inset 0 0 60px ${colors.accentGlow}`,
          opacity: interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" }),
        }}
      />

      {/* Pulsing core */}
      {(() => {
        const pulse = Math.sin(frame * 0.1) * 0.15 + 1;
        const absorbed = files.filter((_, i) => frame > files[i].delay + 25).length;
        const intensity = 0.3 + absorbed * 0.2;
        return (
          <div style={{
            position: "absolute", width: 40, height: 40, borderRadius: "50%",
            background: `radial-gradient(circle, ${colors.accent}${Math.round(intensity * 255).toString(16).padStart(2, '0')} 0%, transparent 70%)`,
            transform: `scale(${pulse + absorbed * 0.5})`,
          }} />
        );
      })()}

      {/* File drops */}
      {files.map((file, i) => {
        const localFrame = frame - file.delay;
        if (localFrame < 0) return null;

        const drop = spring({ fps, frame: localFrame, config: { damping: 12, stiffness: 80 }, durationInFrames: 20 });
        const y = interpolate(drop, [0, 1], [-180, 0]);
        const absorb = interpolate(localFrame, [20, 35], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const scale = interpolate(localFrame, [20, 35], [1, 0.3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const xOffset = (i - Math.floor((files.length - 1) / 2)) * 160;

        const label = (file.name.split('.').pop() ?? file.name.slice(0, 4)).toUpperCase().slice(0, 4);

        return (
          <div key={file.name + i} style={{ position: "absolute", transform: `translate(${xOffset}px, ${y}px) scale(${scale})`, opacity: absorb }}>
            <div style={{ ...glass, padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: `${file.color}20`, border: `1px solid ${file.color}40`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, color: file.color,
              }}>{label}</div>
              <div>
                <div style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.text }}>{file.name}</div>
                <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted }}>from {file.source}</div>
              </div>
            </div>
          </div>
        );
      })}

      {/* Counters */}
      <div style={{ position: "absolute", bottom: 140, display: "flex", gap: 32 }}>
        {counters.map((c, i) => (
          <Counter key={i} from={0} to={c.to} startFrame={c.startFrame} durationFrames={50} label={c.label} />
        ))}
      </div>
    </AbsoluteFill>
  );
};
