import type { VideoBlock } from "./types";

export interface BulletListParams {
  /** The bullet items. Renders as a newline-joined list with word-by-word reveal. */
  items: string[];
  /** Optional heading shown above the list. */
  heading?: string;
}

export const bulletList: VideoBlock<BulletListParams> = {
  id: "bullet-list",
  name: "Bullet list",
  category: "narrative",
  description: "List of bullets that reveal in sequence. Text-layer joins items with a bullet glyph.",
  defaultDurationFrames: 180,
  paramSchema: {
    items: { type: "string[]", required: true, description: "Array of bullet strings (2-5 items)." },
    heading: { type: "string", description: "Optional heading." },
  },
  build(params) {
    const items = params.items ?? [];
    const heading = params.heading;
    const content = items.map(i => `\u2022  ${i}`).join("\n");
    return {
      kind: "composable",
      durationInFrames: bulletList.defaultDurationFrames,
      params: {
        mood: "cool",
        pacing: "steady",
        visualLayers: [
          { primitive: "noise-grid", params: { cols: 24, rows: 13, cellSize: 80, seed: "bullet-list", speed: 0.002 } },
          { primitive: "vignette", params: { intensity: 0.4 } },
        ],
        text: {
          content: heading ? `${heading}\n\n${content}` : content,
          animation: "word-by-word",
          position: "center",
          fontSize: 44,
          fontWeight: 500,
          fontFamily: "sans",
          maxWidth: 1400,
        },
      },
    };
  },
};
