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
  breathe, shimmer, drift2D,
  SceneBackground, FilmGrain,
  Aurora, Bokeh, GeometricShapes, Vignette, RippleRings, GlowOrb,
  getMoodColors, type SceneMood,
} from "../motion/generative";

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
  { name: "Scout", role: "Research", icon: "🔍", color: "#3b82f6" },
  { name: "Scribe", role: "Content", icon: "📝", color: "#22c55e" },
  { name: "Sentinel", role: "Monitoring", icon: "🛡️", color: "#a855f7" },
  { name: "Broker", role: "Outreach", icon: "📧", color: "#f97316" },
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
  const mood = params?.mood ?? 'electric';
  const m = getMoodColors(mood);
  const accent = params?.accentColor ?? m.accent;

  const cardColors = [m.accent, m.secondary, '#22c55e', '#a855f7', '#e11d48', '#06b6d4'];

  return (
    <SceneBackground mood={mood} intensity={0.6}>
      <Aurora colors={[accent, m.secondary, `${accent}60`]} speed={0.005} opacity={0.1} y="20%" />
      <Bokeh count={6} colors={[accent, m.secondary]} seed="roster-b" minSize={60} maxSize={140} speed={0.003} />
      <GeometricShapes count={5} color={m.secondary} seed="roster-geo" opacity={0.04} shapes={['diamond', 'circle']} />
      <RippleRings cx="50%" cy="50%" color={`${accent}40`} count={3} speed={0.3} maxRadius={350} opacity={0.05} />

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
              <div style={{ fontFamily: fonts.sans, fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
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
      <Vignette intensity={0.45} />
      <FilmGrain intensity={0.03} />
    </SceneBackground>
  );
};
