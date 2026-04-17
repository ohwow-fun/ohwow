import type { VideoBlock } from "./types";

export interface QuoteCardParams {
  /** The quote body, without surrounding quotation marks. */
  quote: string;
  /** Attribution line (e.g., author name, company). */
  attribution?: string;
}

export const quoteCard: VideoBlock<QuoteCardParams> = {
  id: "quote-card",
  name: "Quote card",
  category: "narrative",
  description: "Pull-quote with optional attribution over a constellation backdrop. Slow, reflective pacing.",
  defaultDurationFrames: 210,
  paramSchema: {
    quote: { type: "string", required: true, description: "The quote text." },
    attribution: { type: "string", description: "Who said it." },
  },
  build(params) {
    const { quote = "", attribution } = params;
    return {
      kind: "composable",
      durationInFrames: quoteCard.defaultDurationFrames,
      params: {
        mood: "midnight",
        pacing: "reflective",
        visualLayers: [
          { primitive: "constellation", params: { nodeCount: 18, speed: 0.002, lineOpacity: 0.12, dotSize: 2 } },
          { primitive: "gradient-wash", params: { speed: 0.0015, angle: 60, opacity: 0.1 } },
          { primitive: "vignette", params: { intensity: 0.5 } },
        ],
        text: {
          content: `\u201C${quote}\u201D`,
          subtitle: attribution ? `\u2014 ${attribution}` : undefined,
          animation: "fade-in",
          position: "center",
          fontSize: 56,
          fontWeight: 400,
          fontFamily: "sans",
          maxWidth: 1400,
        },
      },
    };
  },
};
