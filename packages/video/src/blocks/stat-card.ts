import type { VideoBlock } from "./types";

export interface StatCardParams {
  /** The headline number or value (e.g., "42", "$2.1M", "87%"). */
  value: string;
  /** Supporting label (e.g., "users onboarded", "revenue growth"). */
  label: string;
  /** Optional delta indicator (e.g., "+12%", "-3.4%"). Rendered as subtitle. */
  delta?: string;
}

export const statCard: VideoBlock<StatCardParams> = {
  id: "stat-card",
  name: "Stat card",
  category: "metrics",
  description: "Large headline number with a label and optional delta indicator. Pulse-ring accent.",
  defaultDurationFrames: 120,
  paramSchema: {
    value: { type: "string", required: true, description: "The headline value. Keep short (1-6 chars)." },
    label: { type: "string", required: true, description: "Supporting label." },
    delta: { type: "string", description: "Optional delta indicator like +12%." },
  },
  build(params) {
    const { value = "0", label = "", delta } = params;
    return {
      kind: "composable",
      durationInFrames: statCard.defaultDurationFrames,
      params: {
        mood: "electric",
        pacing: "urgent",
        visualLayers: [
          { primitive: "gradient-wash", params: { speed: 0.004, angle: 30, opacity: 0.2 } },
          { primitive: "pulse-ring", params: { cx: 0.5, cy: 0.5, radius: 180, speed: 1.2, thickness: 2 } },
          { primitive: "vignette", params: { intensity: 0.4 } },
        ],
        text: {
          content: value,
          subtitle: delta ? `${delta}  ·  ${label}` : label,
          animation: "count-up",
          position: "center",
          fontSize: 180,
          fontWeight: 800,
          fontFamily: "display",
        },
      },
    };
  },
};
