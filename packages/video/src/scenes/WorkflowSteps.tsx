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
  breathe, shimmer,
  SceneBackground, FilmGrain,
  ConstellationNet, GlowOrb, Vignette, GradientWash,
  getMoodColors, type SceneMood,
} from "../motion/generative";

interface Step {
  label: string;
  icon?: string;
  description?: string;
  delay?: number;
}

export interface WorkflowStepsParams {
  steps: Step[];
  accentColor?: string;
  connectorColor?: string;
  mood?: SceneMood;
}

const DEFAULT_STEPS: Step[] = [
  { label: "Observe", icon: "👁️", description: "Your agents watch everything" },
  { label: "Remember", icon: "🧠", description: "Knowledge compounds daily" },
  { label: "Act", icon: "⚡", description: "Tasks execute autonomously" },
  { label: "Learn", icon: "🔄", description: "Every outcome makes them better" },
];

export const WorkflowSteps: React.FC<{
  params?: Partial<WorkflowStepsParams>;
  durationInFrames?: number;
}> = ({ params }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const steps = params?.steps?.length ? params.steps : DEFAULT_STEPS;
  const mood = params?.mood ?? 'warm';
  const m = getMoodColors(mood);
  const accent = params?.accentColor ?? m.accent;
  const connectorColor = params?.connectorColor ?? accent;

  const stepColors = [m.accent, m.secondary, '#22c55e', '#a855f7', '#e11d48', '#06b6d4'];

  return (
    <SceneBackground mood={mood} intensity={0.5}>
      <ConstellationNet nodeCount={16} color={m.secondary} seed="wf-net" speed={0.002} lineOpacity={0.05} dotSize={2} />
      <GlowOrb cx="50%" cy="50%" size={250} color={`${accent}12`} pulseSpeed={0.03} />
      <GradientWash colors={[accent, m.secondary]} speed={0.004} angle={45} opacity={0.04} />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 0,
          padding: "0 80px",
        }}
      >
        {steps.slice(0, 6).map((step, i) => {
          const delay = step.delay ?? (15 + i * 25);
          const localFrame = frame - delay;
          if (localFrame < 0) {
            return (
              <React.Fragment key={i}>
                <div style={{ width: 160, height: 180 }} />
                {i < steps.length - 1 && <div style={{ width: 60 }} />}
              </React.Fragment>
            );
          }

          const enter = spring({ fps, frame: localFrame, config: { damping: 22, stiffness: 80 }, durationInFrames: 16 });
          const stepColor = stepColors[i % stepColors.length];
          const glow = shimmer(frame, i, 0.03, 0.6);
          const scale = breathe(frame, 0.035 + i * 0.005, 0.012);

          const nextDelay = (steps[i + 1]?.delay ?? (15 + (i + 1) * 25));
          const connectorProgress = i < steps.length - 1
            ? interpolate(frame, [nextDelay - 10, nextDelay + 5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
            : 0;

          return (
            <React.Fragment key={i}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  width: 160,
                  opacity: enter,
                  transform: `scale(${enter * scale}) translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
                }}
              >
                <div
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: "50%",
                    background: `${stepColor}18`,
                    border: `2px solid ${stepColor}60`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 28,
                    marginBottom: 14,
                    boxShadow: glow > 0.3 ? `0 0 ${20 * glow}px ${stepColor}40` : "none",
                  }}
                >
                  {step.icon ?? String(i + 1)}
                </div>

                <div style={{ fontFamily: fonts.sans, fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 6, textAlign: "center" }}>
                  {step.label}
                </div>

                {step.description && (
                  <div
                    style={{
                      fontFamily: fonts.sans,
                      fontSize: 12,
                      color: colors.textMuted,
                      textAlign: "center",
                      maxWidth: 140,
                      opacity: interpolate(localFrame, [8, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
                    }}
                  >
                    {step.description}
                  </div>
                )}
              </div>

              {i < steps.length - 1 && (
                <div style={{ width: 60, display: "flex", alignItems: "center", justifyContent: "center", marginTop: -40 }}>
                  <div
                    style={{
                      width: interpolate(connectorProgress, [0, 1], [0, 40]),
                      height: 2,
                      background: `linear-gradient(90deg, ${connectorColor}60, ${connectorColor}20)`,
                      borderRadius: 1,
                    }}
                  />
                  {connectorProgress > 0.8 && (
                    <div
                      style={{
                        width: 0,
                        height: 0,
                        borderTop: "5px solid transparent",
                        borderBottom: "5px solid transparent",
                        borderLeft: `8px solid ${connectorColor}60`,
                        opacity: interpolate(connectorProgress, [0.8, 1], [0, 1]),
                      }}
                    />
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
      <Vignette intensity={0.4} />
      <FilmGrain intensity={0.03} />
    </SceneBackground>
  );
};
