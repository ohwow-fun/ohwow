import type { VideoBlock } from "./types";

export interface LowerThirdParams {
  /** Primary text (usually a person or entity). */
  name: string;
  /** Smaller line below. */
  subtitle?: string;
  /** Override accent color (defaults to mood accent). */
  accentColor?: string;
}

export const lowerThird: VideoBlock<LowerThirdParams> = {
  id: "lower-third",
  name: "Lower third",
  category: "overlay",
  description: "Name + subtitle in the bottom-left corner over a subtle gradient wash. Broadcast-style speaker intro.",
  defaultDurationFrames: 150,
  paramSchema: {
    name: { type: "string", required: true, description: "Primary label text." },
    subtitle: { type: "string", description: "Optional secondary line." },
    accentColor: { type: "string", description: "Hex color override for the accent underline." },
  },
  build(params) {
    const { name = "Unnamed", subtitle, accentColor } = params;
    return {
      kind: "composable",
      durationInFrames: lowerThird.defaultDurationFrames,
      params: {
        mood: "midnight",
        pacing: "steady",
        visualLayers: [
          { primitive: "gradient-wash", params: { speed: 0.002, angle: 45, opacity: 0.25 } },
          { primitive: "film-grain", params: { intensity: 0.03 } },
        ],
        text: {
          content: name,
          subtitle,
          animation: "fade-in",
          position: "bottom-left",
          fontSize: 56,
          fontWeight: 600,
          fontFamily: "sans",
          accentColor,
        },
      },
    };
  },
};
