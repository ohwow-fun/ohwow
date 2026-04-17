import type { VideoBlock } from "./types";

export interface TitleCardParams {
  /** Main title. */
  title: string;
  /** Smaller supporting line. */
  subtitle?: string;
}

export const titleCard: VideoBlock<TitleCardParams> = {
  id: "title-card",
  name: "Title card",
  category: "titling",
  description: "Centered title with aurora backdrop and a shadow-trail reveal. Use for section openers.",
  defaultDurationFrames: 180,
  paramSchema: {
    title: { type: "string", required: true, description: "Main title (1-5 words works best)." },
    subtitle: { type: "string", description: "Optional subtitle line." },
  },
  build(params) {
    const { title = "Untitled", subtitle } = params;
    return {
      kind: "composable",
      durationInFrames: titleCard.defaultDurationFrames,
      params: {
        mood: "midnight",
        pacing: "reflective",
        visualLayers: [
          { primitive: "aurora", params: { speed: 0.006, opacity: 0.18, y: 0.35 } },
          { primitive: "bokeh", params: { count: 40, seed: "title-card", minSize: 4, maxSize: 18, speed: 0.003 } },
          { primitive: "vignette", params: { intensity: 0.55 } },
        ],
        text: {
          content: title,
          subtitle,
          animation: "split-reveal",
          position: "center",
          fontSize: 140,
          fontWeight: 700,
          fontFamily: "display",
        },
      },
    };
  },
};
