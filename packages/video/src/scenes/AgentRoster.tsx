import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { colors, fonts, glass } from "../components/design";
import { FlowFieldLayer, PulseRing, GlowOrb, breathe, shimmer, drift2D, SceneBackground, FilmGrain, type SceneMood } from "../motion/generative";

interface AgentCard {
  name: string;
  role: string;
  icon?: string;
  color?: string;
  delay?: number;
}

export interface AgentRosterParams {
  agents: AgentCard[];
  accentColor?: string;
  layout?: "grid" | "stagger";
  mood?: SceneMood;
}

const DEFAULT_AGENTS: AgentCard[] = [
  { name: "Scout", role: "Research", icon: "🔍", color: colors.blue },
  { name: "Scribe", role: "Content", icon: "📝", color: colors.green },
  { name: "Sentinel", role: "Monitoring", icon: "🛡️", color: colors.purple },
  { name: "Broker", role: "Outreach", icon: "📧", color: colors.accent },
];

const ROLE_ICONS: Record<string, string> = {
  research: "🔍", content: "📝", monitoring: "🛡️", outreach: "📧",
  sales: "💼", support: "💬", engineering: "🔧", analytics: "📊",
  marketing: "📣", operations: "⚙️", design: "🎨", strategy: "🎯",
};

function iconForRole(role: string): string {
  const lower = role.toLowerCase();
  for (const [key, icon] of Object.entries(ROLE_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return "🤖";
}

export const AgentRoster: React.FC<{
  params?: Partial<AgentRosterParams>;
  durationInFrames?: number;
}> = ({ params }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const agents = params?.agents?.length ? params.agents : DEFAULT_AGENTS;
  const accent = params?.accentColor ?? colors.accent;

  const cardColors = [colors.accent, colors.blue, colors.green, colors.purple, "#e11d48", "#06b6d4"];

  const mood = params?.mood ?? 'electric';

  return (
    <SceneBackground mood={mood} intensity={0.6}>
      <FlowFieldLayer count={20} seed="roster" speed={0.4} colors={[accent, colors.blue, colors.purple]} />
      <PulseRing cx="50%" cy="50%" radius={300} color={`${accent}40`} speed={0.03} />
      <GlowOrb cx="50%" cy="40%" size={200} color={`${accent}30`} pulseSpeed={0.04} />

      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <div style={{ fontFamily: fonts.display, fontSize: 28, color: colors.textMuted, letterSpacing: 4, textTransform: "uppercase" }}>
          your team
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 20,
          padding: "80px 60px 40px",
          flexWrap: "wrap",
        }}
      >
        {agents.slice(0, 6).map((agent, i) => {
          const delay = agent.delay ?? (15 + i * 18);
          const localFrame = frame - delay;
          if (localFrame < 0) return <div key={i} style={{ width: 200, height: 220 }} />;

          const enter = spring({ fps, frame: localFrame, config: { damping: 22, stiffness: 80 }, durationInFrames: 18 });
          const cardColor = agent.color ?? cardColors[i % cardColors.length];
          const icon = agent.icon ?? iconForRole(agent.role);
          const d = drift2D(`agent-${i}`, frame, 0.004, 3);
          const scale = breathe(frame, 0.04 + i * 0.008, 0.015);
          const glow = shimmer(frame, i, 0.025, 0.4);

          return (
            <div
              key={i}
              style={{
                ...glass,
                width: 200,
                padding: "28px 20px",
                opacity: enter,
                transform: `scale(${enter * scale}) translateY(${interpolate(enter, [0, 1], [40, 0]) + d.y}px) translateX(${d.x}px)`,
                textAlign: "center",
                borderTop: `2px solid ${cardColor}60`,
                boxShadow: glow > 0.2
                  ? `0 0 ${30 * glow}px ${cardColor}30, inset 0 0 ${15 * glow}px ${cardColor}08`
                  : "none",
              }}
            >
              <div
                style={{
                  fontSize: 40,
                  marginBottom: 12,
                  transform: `scale(${interpolate(localFrame, [0, 12], [0.3, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })})`,
                }}
              >
                {icon}
              </div>
              <div
                style={{
                  fontFamily: fonts.sans,
                  fontSize: 18,
                  fontWeight: 600,
                  color: colors.text,
                  marginBottom: 4,
                }}
              >
                {agent.name}
              </div>
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  color: cardColor,
                  textTransform: "uppercase",
                  letterSpacing: 1.5,
                  opacity: interpolate(localFrame, [8, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
                }}
              >
                {agent.role}
              </div>
            </div>
          );
        })}
      </div>
      <FilmGrain intensity={0.03} />
    </SceneBackground>
  );
};
