/**
 * Scene: Prompts grid — rolling, glowing list of AI prompts the user sends across apps.
 *
 * Parametrized: `params.prompts[]` overrides the baked prompts (pass real task
 * titles from the workspace), `params.appColors` customises per-app accents,
 * `params.stagger` and `params.scrollRange` tune the reveal motion.
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
import type { PromptsGridParams } from "../spec/kinds";

const DEFAULT_PROMPTS: NonNullable<PromptsGridParams['prompts']> = [
  { text: "Write me a cold email for enterprise leads", time: "8:12 AM", app: "ChatGPT" },
  { text: "Compare Stripe vs Paddle for SaaS billing", time: "9:03 AM", app: "Perplexity" },
  { text: "Refactor this auth middleware to use JWT", time: "9:47 AM", app: "Claude" },
  { text: "What's our churn rate formula again?", time: "10:31 AM", app: "ChatGPT" },
  { text: "Draft a landing page for the new pricing", time: "11:15 AM", app: "Claude" },
  { text: "How do I set up Fly.io GPU instances?", time: "11:58 AM", app: "Gemini" },
  { text: "Summarize this investor update for me", time: "1:22 PM", app: "ChatGPT" },
  { text: "Generate 10 tweet hooks about local-first AI", time: "2:09 PM", app: "Claude" },
  { text: "What did we decide about the onboarding flow?", time: "3:44 PM", app: "ChatGPT" },
  { text: "Debug this Postgres connection pooling issue", time: "4:18 PM", app: "Claude" },
  { text: "Analyze our competitor's pricing page", time: "5:01 PM", app: "Perplexity" },
  { text: "Write the deploy script for staging", time: "6:33 PM", app: "Gemini" },
  { text: "Wait... didn't I already figure this out?", time: "9:47 PM", app: "..." },
];

const DEFAULT_APP_COLORS: Record<string, string> = {
  ChatGPT: colors.chatgpt,
  Claude: colors.claude,
  Gemini: colors.gemini,
  Perplexity: colors.perplexity,
  "...": colors.accent,
};

const DEFAULT_STAGGER = 22;

export const Scene1_You: React.FC<{
  params?: Partial<PromptsGridParams>;
  durationInFrames?: number;
}> = ({ params, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const prompts = params?.prompts?.length ? params.prompts : DEFAULT_PROMPTS;
  const STAGGER = params?.stagger ?? DEFAULT_STAGGER;
  const appColors = { ...DEFAULT_APP_COLORS, ...(params?.appColors ?? {}) };
  const scrollRange = params?.scrollRange ?? [200, -280];

  const scrollEnd = durationInFrames ? Math.max(60, durationInFrames - 10) : 370;
  const scrollY = interpolate(frame, [0, scrollEnd], scrollRange, { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: colors.bg, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: 0, right: 0, top: 0, bottom: 80,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          transform: `translateY(${scrollY}px)`,
        }}
      >
        {prompts.map((prompt, i) => {
          const enterDelay = i * STAGGER;
          const localFrame = frame - enterDelay;
          if (localFrame < 0) return null;

          const enter = spring({ fps, frame: localFrame, config: { damping: 30, stiffness: 100 }, durationInFrames: 10 });
          const isLast = i === prompts.length - 1;
          const appColor = appColors[prompt.app] || colors.textMuted;
          const drift = noise2D(`p-${i}`, frame * 0.003, i) * 8;

          const visiblePrompts = Math.floor(frame / STAGGER);
          const age = visiblePrompts - i;
          const ageFade = interpolate(age, [0, 6, 10], [1, 0.5, 0.15], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });

          return (
            <div
              key={i}
              style={{
                opacity: enter * ageFade,
                transform: `translateX(${drift}px) scale(${interpolate(enter, [0, 1], [0.95, 1])})`,
                width: isLast ? 520 : 480,
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  ...glass,
                  padding: isLast ? "14px 18px" : "10px 16px",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  borderLeft: isLast ? `2px solid ${colors.accent}` : `2px solid ${appColor}30`,
                  background: isLast ? "rgba(249, 115, 22, 0.06)" : glass.background,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", minWidth: 58, gap: 2, flexShrink: 0 }}>
                  <span style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.textDim }}>{prompt.time}</span>
                  <span style={{ fontFamily: fonts.mono, fontSize: 8, color: appColor, fontWeight: 600 }}>{prompt.app}</span>
                </div>
                <div style={{
                  fontFamily: fonts.sans, fontSize: isLast ? 14 : 12,
                  color: isLast ? colors.accent : colors.text,
                  fontWeight: isLast ? 600 : 400, lineHeight: 1.4,
                  fontStyle: isLast ? "italic" : "normal",
                }}>
                  {(() => {
                    const chars = Math.min(prompt.text.length, Math.floor(interpolate(localFrame, [0, 22], [0, prompt.text.length], { extrapolateRight: "clamp" })));
                    return prompt.text.slice(0, chars) + (chars < prompt.text.length && localFrame < 24 ? "▍" : "");
                  })()}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Prompt counter */}
      {frame >= 30 && (() => {
        const count = Math.min(prompts.length - 1, Math.floor((frame - 30) / STAGGER) + 1);
        const opacity = interpolate(frame, [30, 60], [0, 0.4], { extrapolateRight: "clamp" });
        return (
          <div style={{ position: "absolute", top: 24, right: 32, fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, opacity }}>
            {count} prompts today across {Math.min(4, Math.ceil(count / 3))} apps
          </div>
        );
      })()}
    </AbsoluteFill>
  );
};
