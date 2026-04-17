import type { VideoBlock } from "./types";

export interface MetricDashboardParams {
  /** Exactly 3 metrics work best; more or fewer also render but aren't styled. */
  metrics: { value: string; label: string }[];
  /** Optional centered heading above the metrics row. */
  heading?: string;
}

export const metricDashboard: VideoBlock<MetricDashboardParams> = {
  id: "metric-dashboard",
  name: "Metric dashboard",
  category: "metrics",
  description: "Three-up metric grid with pulse-ring accents. Good for KPI reveals and post-incident recaps.",
  defaultDurationFrames: 150,
  paramSchema: {
    metrics: { type: "object[]", required: true, description: "Array of { value, label } objects." },
    heading: { type: "string", description: "Optional heading." },
  },
  build(params) {
    const metrics = params.metrics ?? [];
    const heading = params.heading;
    // Text layer summarises all metrics on one line since TextLayer supports one content string.
    // The visual interest comes from the layered pulse-rings at different positions.
    const content = metrics.map(m => `${m.value}  ${m.label}`).join("   \u00b7   ");
    return {
      kind: "composable",
      durationInFrames: metricDashboard.defaultDurationFrames,
      params: {
        mood: "electric",
        pacing: "urgent",
        visualLayers: [
          { primitive: "gradient-wash", params: { speed: 0.003, angle: 15, opacity: 0.18 } },
          { primitive: "pulse-ring", params: { cx: 0.25, cy: 0.5, radius: 140, speed: 1.0, thickness: 2 } },
          { primitive: "pulse-ring", params: { cx: 0.5,  cy: 0.5, radius: 140, speed: 1.1, thickness: 2 } },
          { primitive: "pulse-ring", params: { cx: 0.75, cy: 0.5, radius: 140, speed: 1.2, thickness: 2 } },
          { primitive: "vignette", params: { intensity: 0.35 } },
        ],
        text: {
          content: heading ? `${heading}\n\n${content}` : content,
          animation: "fade-in",
          position: "center",
          fontSize: 42,
          fontWeight: 600,
          fontFamily: "sans",
          maxWidth: 1600,
        },
      },
    };
  },
};
