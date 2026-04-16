/**
 * Scene 4: The Life (frames 0-315)
 * Voice: "This is what your week looks like. Not automation. A team that thinks
 *         for itself. You do the work only you can do. Everything else is handled." (9.5s)
 *
 * Dense, alive scene with floating icons, connection lines, and orbital elements
 * surrounding the benefit cards.
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
import { colors, fonts, glass } from "../components/design";
import { Caption } from "../components/Caption";

// Floating automation icons that orbit around the cards
const floatingIcons = [
  { emoji: "🤖", size: 22, orbit: 0, speed: 0.008, radius: 340, yRatio: 0.4 },
  { emoji: "📧", size: 18, orbit: 0.5, speed: 0.012, radius: 380, yRatio: 0.35 },
  { emoji: "📊", size: 20, orbit: 1.2, speed: 0.01, radius: 350, yRatio: 0.45 },
  { emoji: "🔍", size: 16, orbit: 2.0, speed: 0.014, radius: 400, yRatio: 0.3 },
  { emoji: "💬", size: 20, orbit: 2.8, speed: 0.009, radius: 360, yRatio: 0.4 },
  { emoji: "📝", size: 18, orbit: 3.5, speed: 0.011, radius: 390, yRatio: 0.35 },
  { emoji: "⚡", size: 22, orbit: 4.2, speed: 0.013, radius: 370, yRatio: 0.38 },
  { emoji: "🌐", size: 17, orbit: 4.8, speed: 0.01, radius: 410, yRatio: 0.32 },
  { emoji: "📱", size: 19, orbit: 5.5, speed: 0.015, radius: 345, yRatio: 0.42 },
  { emoji: "🔗", size: 16, orbit: 0.8, speed: 0.007, radius: 420, yRatio: 0.28 },
  { emoji: "✨", size: 14, orbit: 1.8, speed: 0.016, radius: 330, yRatio: 0.5 },
  { emoji: "🛡️", size: 16, orbit: 3.0, speed: 0.009, radius: 405, yRatio: 0.33 },
  { emoji: "📅", size: 18, orbit: 3.8, speed: 0.012, radius: 355, yRatio: 0.44 },
  { emoji: "💡", size: 20, orbit: 5.0, speed: 0.008, radius: 385, yRatio: 0.36 },
];

// Connection particles that flow between cards
const connectionDots = Array.from({ length: 30 }, (_, i) => ({
  seed: `conn-${i}`,
  speed: 0.5 + (i % 5) * 0.3,
  size: 2 + (i % 3),
}));

const outcomes = [
  { text: "You wake up. Your agents already handled overnight leads.", color: colors.accent, icon: "☀️", delay: 10 },
  { text: "A client messages on WhatsApp. Your AI responds in your voice.", color: colors.green, icon: "💬", delay: 30 },
  { text: "Competitor changes pricing. You know before they announce it.", color: colors.blue, icon: "🔍", delay: 50 },
  { text: "Your blog post is drafted, reviewed, and scheduled. You didn't open a doc.", color: colors.purple, icon: "📝", delay: 75 },
  { text: "A bug gets reported. Your agent reads the logs, finds the fix, opens a PR.", color: colors.accent, icon: "🔧", delay: 100 },
  { text: "Investor update goes out. Metrics pulled, copy written, email sent.", color: colors.blue, icon: "📊", delay: 125 },
  { text: "You take Friday off. Nothing breaks. Nothing waits.", color: colors.green, icon: "🏖️", delay: 155 },
  { text: "Your CRM updates itself after every conversation.", color: colors.purple, icon: "🔄", delay: 180 },
  { text: "You focus on the work only you can do. Everything else is handled.", color: colors.accent, icon: "🎯", delay: 205 },
];

export const Scene5_ZoomOut: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const globalEnter = spring({ fps, frame, config: { damping: 200 }, durationInFrames: 20 });

  return (
    <AbsoluteFill style={{ background: colors.bg, overflow: "hidden" }}>

      {/* Background: subtle radial gradient pulse */}
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(ellipse at 50% 45%, rgba(249,115,22,${0.03 + Math.sin(frame * 0.03) * 0.01}) 0%, transparent 60%)`,
      }} />

      {/* Floating automation icons orbiting the scene */}
      {floatingIcons.map((icon, i) => {
        const angle = icon.orbit + frame * icon.speed;
        const x = Math.cos(angle) * icon.radius;
        const y = Math.sin(angle) * icon.radius * icon.yRatio;
        const fadeIn = interpolate(frame, [i * 8, i * 8 + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const depthScale = 0.6 + (Math.sin(angle) + 1) * 0.2; // parallax depth
        const depthOpacity = 0.15 + (Math.sin(angle) + 1) * 0.15;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `calc(50% + ${x}px)`,
              top: `calc(45% + ${y}px)`,
              fontSize: icon.size,
              opacity: fadeIn * depthOpacity,
              transform: `scale(${depthScale})`,
              filter: `blur(${(1 - depthScale) * 2}px)`,
              pointerEvents: "none",
            }}
          >
            {icon.emoji}
          </div>
        );
      })}

      {/* Connection particles flowing between card positions */}
      {connectionDots.map((dot, i) => {
        const progress = ((frame * dot.speed + i * 40) % 400) / 400;
        // Flow in random directions across the card grid area
        const startAngle = (i / connectionDots.length) * Math.PI * 2;
        const x = Math.cos(startAngle + progress * 2) * (150 + progress * 200);
        const y = Math.sin(startAngle + progress * 3) * (80 + progress * 100);
        const opacity = Math.sin(progress * Math.PI) * 0.4 * globalEnter;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `calc(50% + ${x}px)`,
              top: `calc(45% + ${y}px)`,
              width: dot.size,
              height: dot.size,
              borderRadius: "50%",
              background: i % 3 === 0 ? colors.accent : i % 3 === 1 ? colors.blue : colors.green,
              opacity,
              boxShadow: `0 0 ${dot.size * 3}px currentColor`,
              pointerEvents: "none",
            }}
          />
        );
      })}

      {/* Thin orbital ring */}
      <div style={{
        position: "absolute",
        left: "50%", top: "45%",
        width: 700, height: 280,
        marginLeft: -350, marginTop: -140,
        border: `1px solid rgba(255,255,255,0.03)`,
        borderRadius: "50%",
        transform: `rotate(${frame * 0.15}deg)`,
        pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute",
        left: "50%", top: "45%",
        width: 800, height: 320,
        marginLeft: -400, marginTop: -160,
        border: `1px solid rgba(255,255,255,0.02)`,
        borderRadius: "50%",
        transform: `rotate(${-frame * 0.1}deg)`,
        pointerEvents: "none",
      }} />

      {/* Outcome cards — 3-column grid with icons */}
      <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", zIndex: 5 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 350px)", gap: 12, padding: "0 30px" }}>
          {outcomes.map((item, i) => {
            const enter = spring({ fps, frame: frame - item.delay, config: { damping: 25, stiffness: 90 }, durationInFrames: 14 });
            if (frame < item.delay) return <div key={i} style={{ height: 80 }} />;

            const breath = noise2D(`o-${i}`, frame * 0.015, i) * 0.008 + 1;
            const glowPhase = ((frame - 80) * 0.04 - i * 0.3) % (Math.PI * 2);
            const glowIntensity = Math.max(0, Math.sin(glowPhase)) * 0.35;

            return (
              <div key={i} style={{
                ...glass, padding: "12px 16px", opacity: enter,
                transform: `scale(${enter * breath}) translateY(${interpolate(enter, [0, 1], [20, 0])}px)`,
                borderLeft: `2px solid ${item.color}40`,
                boxShadow: glowIntensity > 0.05
                  ? `0 0 ${25 * glowIntensity}px ${item.color}${Math.round(glowIntensity * 100).toString(16).padStart(2, "0")}, inset 0 0 ${15 * glowIntensity}px ${item.color}10`
                  : "none",
                minHeight: 68, display: "flex", alignItems: "center", gap: 12,
              }}>
                {/* Icon */}
                <span style={{
                  fontSize: 22, flexShrink: 0,
                  opacity: interpolate(frame - item.delay, [5, 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
                  transform: `scale(${interpolate(frame - item.delay, [5, 18], [0.5, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })})`,
                }}>
                  {item.icon}
                </span>
                <div style={{ fontFamily: fonts.sans, fontSize: 12.5, color: colors.text, lineHeight: 1.45 }}>
                  {(() => {
                    const localFrame = frame - item.delay;
                    const chars = Math.min(item.text.length, Math.floor(interpolate(localFrame, [0, 30], [0, item.text.length], { extrapolateRight: "clamp" })));
                    return item.text.slice(0, chars);
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom fade */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: 100,
        background: `linear-gradient(transparent, ${colors.bg})`, pointerEvents: "none", zIndex: 6,
      }} />

      {/* Captions */}
      <Caption text="This is what your week looks like." highlight={["your"]} startFrame={0} durationFrames={80} />
      <Caption text="Not automation. A team that thinks for itself." highlight={["thinks"]} startFrame={85} durationFrames={90} />
      <Caption text="You do the work only you can do. Everything else is handled." highlight={["only", "you", "handled."]} startFrame={190} durationFrames={110} />
    </AbsoluteFill>
  );
};
