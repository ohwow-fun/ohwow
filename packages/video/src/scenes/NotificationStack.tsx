import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { colors, fonts, glass } from "../components/design";
import { FlowFieldLayer, PulseRing, GlowOrb, breathe, drift2D } from "../motion/generative";

interface Notification {
  text: string;
  icon?: string;
  color?: string;
  delay?: number;
}

export interface NotificationStackParams {
  notifications: Notification[];
  accentColor?: string;
  deviceFrame?: boolean;
}

const DEFAULT_NOTIFICATIONS: Notification[] = [
  { text: "Scout found 3 competitor updates", icon: "🔍", color: colors.blue },
  { text: "Weekly recap drafted and scheduled", icon: "📝", color: colors.green },
  { text: "2 leads responded overnight", icon: "📧", color: colors.accent },
  { text: "Uptime: 99.98% over 30 days", icon: "🛡️", color: colors.purple },
  { text: "Knowledge base updated with 12 new entries", icon: "🧠", color: "#06b6d4" },
  { text: "Invoice #847 sent automatically", icon: "💰", color: colors.green },
];

export const NotificationStack: React.FC<{
  params?: Partial<NotificationStackParams>;
  durationInFrames?: number;
}> = ({ params }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const notifications = params?.notifications?.length ? params.notifications : DEFAULT_NOTIFICATIONS;
  const accent = params?.accentColor ?? colors.accent;
  const showDevice = params?.deviceFrame !== false;

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <FlowFieldLayer count={18} seed="notif" speed={0.5} colors={[accent, colors.blue, colors.purple]} />
      <PulseRing cx="50%" cy="50%" radius={280} color={`${accent}30`} speed={0.035} />
      <GlowOrb cx="50%" cy="45%" size={180} color={`${accent}20`} pulseSpeed={0.04} />

      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: `translate(-50%, -50%) scale(${breathe(frame, 0.02, 0.006)})`,
        }}
      >
        {showDevice && (
          <div
            style={{
              width: 380,
              minHeight: 500,
              background: "rgba(15, 15, 25, 0.95)",
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: 32,
              padding: "48px 20px 28px",
              boxShadow: `0 0 80px rgba(0,0,0,0.6), 0 0 40px ${accent}08`,
              overflow: "hidden",
            }}
          >
            {/* Status bar */}
            <div
              style={{
                position: "absolute",
                top: 14,
                left: 0,
                right: 0,
                display: "flex",
                justifyContent: "center",
                opacity: 0.3,
              }}
            >
              <div style={{ width: 80, height: 4, borderRadius: 2, background: colors.textMuted }} />
            </div>

            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                color: colors.textMuted,
                textTransform: "uppercase",
                letterSpacing: 2,
                marginBottom: 16,
                textAlign: "center",
                opacity: interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" }),
              }}
            >
              while you were away
            </div>

            {notifications.slice(0, 7).map((notif, i) => {
              const delay = notif.delay ?? (15 + i * 15);
              const localFrame = frame - delay;
              if (localFrame < 0) return <div key={i} style={{ height: 58 }} />;

              const enter = spring({ fps, frame: localFrame, config: { damping: 20, stiffness: 100 }, durationInFrames: 14 });
              const notifColor = notif.color ?? accent;
              const d = drift2D(`notif-${i}`, frame, 0.003, 1.5);

              return (
                <div
                  key={i}
                  style={{
                    ...glass,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 14px",
                    marginBottom: 8,
                    opacity: enter,
                    transform: `translateY(${interpolate(enter, [0, 1], [20, 0]) + d.y}px) translateX(${d.x}px)`,
                    borderLeft: `2px solid ${notifColor}60`,
                  }}
                >
                  <span style={{ fontSize: 18, flexShrink: 0 }}>{notif.icon ?? "🔔"}</span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.text, lineHeight: 1.4 }}>
                    {notif.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {!showDevice && (
          <div style={{ width: 500, display: "flex", flexDirection: "column", gap: 10 }}>
            {notifications.slice(0, 7).map((notif, i) => {
              const delay = notif.delay ?? (15 + i * 15);
              const localFrame = frame - delay;
              if (localFrame < 0) return <div key={i} style={{ height: 58 }} />;

              const enter = spring({ fps, frame: localFrame, config: { damping: 20, stiffness: 100 }, durationInFrames: 14 });
              const notifColor = notif.color ?? accent;

              return (
                <div
                  key={i}
                  style={{
                    ...glass,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "14px 18px",
                    opacity: enter,
                    transform: `translateX(${interpolate(enter, [0, 1], [-40, 0])}px)`,
                    borderLeft: `3px solid ${notifColor}60`,
                  }}
                >
                  <span style={{ fontSize: 22 }}>{notif.icon ?? "🔔"}</span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.text }}>{notif.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
