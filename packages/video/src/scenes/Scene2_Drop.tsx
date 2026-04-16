/**
 * Scene 2: The Drop (frames 0-120)
 * Voice: "Bring your conversations. All of them." (2.9s)
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
import { Caption } from "../components/Caption";

const files = [
  { name: "conversations.json", source: "ChatGPT", color: colors.chatgpt, delay: 0 },
  { name: "claude-export.json", source: "Claude", color: colors.claude, delay: 15 },
  { name: "chats.json", source: "Gemini", color: colors.gemini, delay: 30 },
];

export const Scene2: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

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
        const xOffset = (i - 1) * 160;

        return (
          <div key={file.name} style={{ position: "absolute", transform: `translate(${xOffset}px, ${y}px) scale(${scale})`, opacity: absorb }}>
            <div style={{ ...glass, padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: `${file.color}20`, border: `1px solid ${file.color}40`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, color: file.color,
              }}>JSON</div>
              <div>
                <div style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.text }}>{file.name}</div>
                <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted }}>from {file.source}</div>
              </div>
            </div>
          </div>
        );
      })}

      {/* Counter */}
      <div style={{ position: "absolute", bottom: 140, display: "flex", gap: 32 }}>
        <Counter from={0} to={214} startFrame={40} durationFrames={50} label="conversations" />
        <Counter from={0} to={4891} startFrame={50} durationFrames={50} label="messages" />
      </div>

      {/* Caption synced to voice: 2.9s */}
      <Caption text="Bring your conversations. All of them." highlight={["All"]} startFrame={0} durationFrames={87} />
    </AbsoluteFill>
  );
};
