import type { VideoBlock } from "./types";

export interface CaptionStripParams {
  /** The caption body. Keep under ~80 chars for legibility. */
  text: string;
  /** Override mood accent color. */
  accentColor?: string;
}

export const captionStrip: VideoBlock<CaptionStripParams> = {
  id: "caption-strip",
  name: "Caption strip",
  category: "overlay",
  description: "Full-width caption bar at the bottom. Mood-aware background, fade-in animation.",
  defaultDurationFrames: 90,
  paramSchema: {
    text: { type: "string", required: true, description: "Caption content." },
    accentColor: { type: "string", description: "Override accent color." },
  },
  build(params) {
    const { text = "", accentColor } = params;
    return {
      kind: "composable",
      durationInFrames: captionStrip.defaultDurationFrames,
      params: {
        mood: "cool",
        pacing: "steady",
        visualLayers: [
          { primitive: "gradient-wash", params: { speed: 0.001, angle: 90, opacity: 0.15 } },
        ],
        text: {
          content: text,
          animation: "word-by-word",
          position: "bottom-center",
          fontSize: 44,
          fontWeight: 500,
          fontFamily: "sans",
          maxWidth: 1400,
          accentColor,
        },
      },
    };
  },
};
