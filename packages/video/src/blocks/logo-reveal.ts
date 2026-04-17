import type { VideoBlock } from "./types";

export interface LogoRevealParams {
  /** Wordmark / logo text fallback. Use when you don't have an image src. */
  wordmark: string;
  /** Optional tagline below the logo. */
  tagline?: string;
}

export const logoReveal: VideoBlock<LogoRevealParams> = {
  id: "logo-reveal",
  name: "Logo reveal",
  category: "cta",
  description: "Logo or wordmark emerges from a particle-burst. Use as the final CTA or intro stinger.",
  defaultDurationFrames: 150,
  paramSchema: {
    wordmark: { type: "string", required: true, description: "Wordmark or brand text to reveal." },
    tagline: { type: "string", description: "Optional tagline under the logo." },
  },
  build(params) {
    const { wordmark = "ohwow", tagline } = params;
    return {
      kind: "composable",
      durationInFrames: logoReveal.defaultDurationFrames,
      params: {
        mood: "electric",
        pacing: "urgent",
        visualLayers: [
          { primitive: "particle-burst", params: { count: 80, cx: 0.5, cy: 0.5, seed: "logo-reveal", speed: 1.4, size: 6 } },
          { primitive: "glow-orb", params: { cx: 0.5, cy: 0.5, size: 420, pulseSpeed: 0.6 } },
          { primitive: "film-grain", params: { intensity: 0.04 } },
        ],
        text: {
          content: wordmark,
          subtitle: tagline,
          animation: "letter-scatter",
          position: "center",
          fontSize: 160,
          fontWeight: 800,
          fontFamily: "display",
        },
      },
    };
  },
};
