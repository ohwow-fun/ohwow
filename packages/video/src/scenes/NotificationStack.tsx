import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { colors, fonts, glass } from "../components/design";
import {
  breathe, drift2D,
  SceneBackground, FilmGrain,
  Aurora, LightRays, Vignette, GlowOrb,
  getMoodColors, type SceneMood,
} from "../motion/generative";

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
  mood?: SceneMood;
}

const DEFAULT_NOTIFICATIONS: Notification[] = [
  { text: "Scout found 3 competitor updates", icon: "🔍", color: "#3b82f6" },
  { text: "Weekly recap drafted and scheduled", icon: "📝", color: "#22c55e" },
  { text: "2 leads responded overnight", icon: "📧", color: "#f97316" },
  { text: "Uptime: 99.98% over 30 days", icon: "🛡️", color: "#a855f7" },
  { text: "Knowledge base updated with 12 new entries", icon: "🧠", color: "#06b6d4" },
  { text: "Invoice #847 sent automatically", icon: "💰", color: "#22c55e" },
];

export const NotificationStack: React.FC<{
  params?: Partial<NotificationStackParams>;
  durationInFrames?: number;
}> = ({ params }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const notifications = params?.notifications?.length ? params.notifications : DEFAULT_NOTIFICATIONS;
  const mood = params?.mood ?? 'cool';
  const m = getMoodColors(mood);
  const accent = params?.accentColor ?? m.accent;
  const showDevice = params?.deviceFrame !== false;

  return (
    <SceneBackground mood={mood} intensity={0.5}>
      <Aurora colors={[accent, m.secondary]} speed={0.005} opacity={0.08} y="15%" />
      <LightRays count={4} color={accent} originX="50%" originY="0%" spread={30} opacity={0.025} speed={0.008} />
      <GlowOrb cx="50%" cy="40%" size={200} color={`${accent}12`} pulseSpeed={0.035} />

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
              background: "rgba(10, 10, 20, 0.95)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 32,
              padding: "48px 20px 28px",
              boxShadow: `0 0 80px rgba(0,0,0,0.6), 0 0 40px ${accent}08`,
              overflow: "hidden",
            }}
          >
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
      </div>
      <Vignette intensity={0.45} />
      <FilmGrain intensity={0.03} />
    </SceneBackground>
  );
};
