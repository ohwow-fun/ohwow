/**
 * Scene 5: Cloud + CTA (frames 0-280)
 * Voice: "Runs on your laptop. Lives in your pocket. Your agents report in
 *         from anywhere. Conversations die. Knowledge should not." (8.3s)
 */

import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  staticFile,
  Img,
} from "remotion";
import { noise2D } from "@remotion/noise";
import { colors, fonts, glass } from "../components/design";
import { OhwowWordmark } from "../components/logos";
import { CtaMeshParams } from "../spec/kinds";

const DEFAULT_NOTIFICATIONS = [
  { text: "Growth Agent finished your X thread draft", icon: "✍️", color: colors.accent, delay: 40 },
  { text: "New lead: sarah@acme.co replied to cold email", icon: "🔥", color: colors.green, delay: 60 },
  { text: "Blog post scheduled for Thursday 9AM", icon: "📅", color: colors.blue, delay: 78 },
  { text: "Competitor raised prices 20%. Analysis ready.", icon: "📊", color: colors.purple, delay: 96 },
  { text: "3 tasks completed while you were at lunch", icon: "✓", color: colors.green, delay: 114 },
];

const DEFAULT_TERMINAL_LINES = [
  { t: "▶ 3 agents active", c: colors.green, d: 10 },
  { t: "▶ Growth: drafting X thread...", c: colors.accent, d: 22 },
  { t: "▶ Research: monitoring competitors...", c: colors.blue, d: 34 },
  { t: "▶ Sales: following up leads...", c: colors.green, d: 46 },
  { t: "  127 memories | 214 conversations", c: colors.textMuted, d: 58 },
  { t: "  ✓ synced to cloud 4s ago", c: colors.textDim, d: 70 },
];

const DataFlow: React.FC<{ frame: number; count: number }> = ({ frame, count }) => {
  const particles = Array.from({ length: count }, (_, i) => i);
  return (
    <>
      {particles.map((i) => {
        const speed = 1.2 + (i % 4) * 0.4;
        const progress = ((frame * speed + i * 25) % 300) / 300;
        const goingRight = i % 3 !== 0;
        const startX = goingRight ? -240 : 240;
        const endX = goingRight ? 240 : -240;
        const x = interpolate(progress, [0, 1], [startX, endX]);
        const arcHeight = Math.sin(progress * Math.PI) * -60;
        const y = arcHeight + noise2D(`flow-${i}`, progress * 3, i) * 10;
        const opacity = Math.sin(progress * Math.PI) * 0.7;
        const size = 3 + (i % 3);
        return (
          <div key={i} style={{
            position: "absolute", left: `calc(50% + ${x}px)`, top: `calc(42% + ${y}px)`,
            width: size, height: size, borderRadius: "50%",
            background: goingRight ? colors.accent : colors.blue,
            opacity: opacity * 0.7,
            boxShadow: `0 0 ${size * 3}px ${goingRight ? colors.accent : colors.blue}50`,
          }} />
        );
      })}
    </>
  );
};

export const Scene6_Cloud: React.FC<{ params?: Partial<CtaMeshParams> }> = ({ params }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const notifications = params?.notifications?.length ? params.notifications : DEFAULT_NOTIFICATIONS;
  const terminalLines = params?.terminalLines?.length ? params.terminalLines : DEFAULT_TERMINAL_LINES;
  const cta = {
    tagline: "Conversations die. Knowledge shouldn\u2019t.",
    subline: "Free and open source.",
    logoSrc: "ohwow-logo.png",
    wordmark: "ohwow",
    showDotFun: true,
    ...params?.cta,
  };
  const ctaStartFrame = params?.ctaStartFrame ?? 160;

  const laptopEnter = spring({ fps, frame: frame - 5, config: { damping: 30, stiffness: 70 }, durationInFrames: 20 });
  const phoneEnter = spring({ fps, frame: frame - 20, config: { damping: 30, stiffness: 70 }, durationInFrames: 20 });
  const flowStart = spring({ fps, frame: frame - 35, config: { damping: 200 }, durationInFrames: 15 });

  // CTA starts at ctaStartFrame
  const ctaPhase = frame >= ctaStartFrame;
  const ctaFade = ctaPhase ? spring({ fps, frame: frame - ctaStartFrame, config: { damping: 200 }, durationInFrames: 25 }) : 0;
  const contentFade = ctaPhase ? interpolate(frame, [ctaStartFrame - 5, ctaStartFrame + 15], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <div style={{ opacity: contentFade }}>
        {/* Laptop */}
        <div style={{
          position: "absolute", left: 60, top: "50%",
          transform: `translateY(-55%) scale(${laptopEnter})`, opacity: laptopEnter,
        }}>
          <div style={{
            width: 420, background: "#111118", borderRadius: 14,
            border: `1px solid ${colors.cardBorder}`, overflow: "hidden",
          }}>
            <div style={{
              padding: "8px 14px", borderBottom: `1px solid ${colors.cardBorder}`,
              display: "flex", alignItems: "center", gap: 6,
            }}>
              <div style={{ display: "flex", gap: 5 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ff5f57" }} />
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ffbd2e" }} />
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#28c840" }} />
              </div>
              <span style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.textDim, marginLeft: 8 }}>
                ohwow runtime — localhost:7700
              </span>
            </div>
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 5 }}>
              {terminalLines.map((line, i) => {
                const enter = spring({ fps, frame: frame - line.d, config: { damping: 200 }, durationInFrames: 10 });
                if (frame < line.d) return <div key={i} style={{ height: 16 }} />;
                return (
                  <div key={i} style={{
                    fontFamily: fonts.mono, fontSize: 11, color: line.c, opacity: enter,
                    transform: `translateX(${interpolate(enter, [0, 1], [10, 0])}px)`,
                  }}>{line.t}</div>
                );
              })}
            </div>
          </div>
          <div style={{
            height: 8, background: "#1a1a22", borderRadius: "0 0 8px 8px",
            marginTop: -1, border: `1px solid ${colors.cardBorder}`, borderTop: "none",
          }} />
        </div>

        {/* Data flow */}
        {frame >= 35 && <div style={{ opacity: flowStart }}><DataFlow frame={frame} count={15} /></div>}

        {/* Phone */}
        <div style={{
          position: "absolute", right: 100, top: "50%",
          transform: `translateY(-55%) scale(${phoneEnter})`, opacity: phoneEnter,
        }}>
          <div style={{
            width: 260, background: "#111118", borderRadius: 24,
            border: `1px solid ${colors.cardBorder}`, padding: "12px 0", overflow: "hidden",
          }}>
            <div style={{ padding: "4px 20px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted }}>9:41</span>
              <Img src={staticFile(cta.logoSrc)} style={{ width: 14, height: 14, borderRadius: 3 }} />
            </div>
            <div style={{ padding: "0 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              {notifications.map((notif, i) => {
                const enter = spring({ fps, frame: frame - notif.delay, config: { damping: 25, stiffness: 100 }, durationInFrames: 12 });
                if (frame < notif.delay) return null;
                return (
                  <div key={i} style={{
                    ...glass, padding: "10px 12px", opacity: enter,
                    transform: `translateY(${interpolate(enter, [0, 1], [15, 0])}px) scale(${interpolate(enter, [0, 1], [0.96, 1])})`,
                    display: "flex", gap: 8, alignItems: "flex-start",
                    borderLeft: `2px solid ${notif.color}30`,
                  }}>
                    <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{notif.icon}</span>
                    <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.text, lineHeight: 1.4 }}>
                      {(() => {
                        const localFrame = frame - notif.delay;
                        const chars = Math.min(notif.text.length, Math.floor(interpolate(localFrame, [0, 20], [0, notif.text.length], { extrapolateRight: "clamp" })));
                        return notif.text.slice(0, chars);
                      })()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* CTA */}
      {ctaPhase && (
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: ctaFade }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <Img src={staticFile(cta.logoSrc)} style={{
              width: 90, height: 90, borderRadius: 22,
              transform: `scale(${interpolate(ctaFade, [0, 1], [0.8, 1])})`,
            }} />
            <OhwowWordmark fontSize={56} showDotFun={cta.showDotFun} />
            <div style={{
              fontFamily: fonts.sans, fontSize: 22, fontWeight: 400, color: colors.textMuted,
              opacity: interpolate(frame - (ctaStartFrame + 20), [0, 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}>
              {cta.tagline}
            </div>
            <div style={{
              fontFamily: fonts.sans, fontSize: 14, color: colors.textDim,
              opacity: interpolate(frame - (ctaStartFrame + 45), [0, 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}>
              {cta.subline}
            </div>
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
