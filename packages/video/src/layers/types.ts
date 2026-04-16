import type { SceneMood } from "../motion/generative";

/**
 * A visual layer is a single composable primitive with its configuration.
 * The LLM outputs an array of these per scene; ComposableScene renders
 * them in Z-order (first = bottom, last = top).
 *
 * Primitives map 1:1 to the exports in motion/generative.tsx.
 */
export interface VisualLayer {
  primitive: VisualLayerPrimitive;
  params?: Record<string, unknown>;
}

export type VisualLayerPrimitive =
  | "aurora"
  | "bokeh"
  | "light-rays"
  | "constellation"
  | "waveform"
  | "geometric"
  | "vignette"
  | "ripple"
  | "gradient-wash"
  | "flow-field"
  | "pulse-ring"
  | "glow-orb"
  | "noise-grid"
  | "scan-line"
  | "film-grain";

export type TextAnimation =
  | "typewriter"
  | "fade-in"
  | "word-by-word"
  | "letter-scatter"
  | "glow-text"
  | "split-reveal"
  | "count-up";

export type TextPosition =
  | "center"
  | "bottom-center"
  | "bottom-left"
  | "top-center";

export interface TextLayer {
  content: string;
  animation?: TextAnimation;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: "sans" | "mono" | "display";
  position?: TextPosition;
  color?: string;
  accentColor?: string;
  subtitle?: string;
  maxWidth?: number;
}

export interface VideoPalette {
  seedHue: number;
  harmony: "analogous" | "complementary" | "triadic" | "split";
  mood: SceneMood;
}

export const PRIMITIVE_CATALOG: Array<{
  primitive: VisualLayerPrimitive;
  name: string;
  description: string;
  keyParams: string;
}> = [
  { primitive: "aurora", name: "Aurora bands", description: "Slow-moving luminous bands with blur. Ethereal, calm.", keyParams: "colors[], speed, opacity, y" },
  { primitive: "bokeh", name: "Bokeh circles", description: "Soft out-of-focus circles drifting. Dreamy, depth.", keyParams: "count, colors[], seed, minSize, maxSize, speed" },
  { primitive: "light-rays", name: "Light rays", description: "Crepuscular rays from a point. Divine, dramatic.", keyParams: "count, color, originX, originY, spread, opacity" },
  { primitive: "constellation", name: "Constellation net", description: "Nodes connected by faint lines. Network, intelligence.", keyParams: "nodeCount, color, seed, speed, lineOpacity" },
  { primitive: "waveform", name: "SVG waveform", description: "Layered sine waves. Audio, rhythm, flow.", keyParams: "color, amplitude, frequency, speed, y, layers" },
  { primitive: "geometric", name: "Geometric shapes", description: "Rotating circles, squares, triangles. Structure, order.", keyParams: "count, color, seed, shapes[], opacity" },
  { primitive: "vignette", name: "Vignette", description: "Edge darkening. Focus, cinematic.", keyParams: "intensity, color" },
  { primitive: "ripple", name: "Ripple rings", description: "Expanding concentric circles. Impact, signal.", keyParams: "cx, cy, color, count, speed, maxRadius, opacity" },
  { primitive: "gradient-wash", name: "Gradient wash", description: "Moving color gradient overlay. Mood, atmosphere.", keyParams: "colors[], speed, angle, opacity" },
  { primitive: "flow-field", name: "Flow field particles", description: "Noise-driven particle swarm. Energy, organic.", keyParams: "count, seed, speed, colors[]" },
  { primitive: "pulse-ring", name: "Pulse ring", description: "Single breathing ring. Heartbeat, life.", keyParams: "cx, cy, radius, color, speed, thickness" },
  { primitive: "glow-orb", name: "Glow orb", description: "Soft radial glow. Warmth, presence.", keyParams: "cx, cy, size, color, pulseSpeed" },
  { primitive: "noise-grid", name: "Noise grid", description: "Grid cells with noise-driven opacity. Data, matrix.", keyParams: "cols, rows, cellSize, seed, color, speed" },
  { primitive: "scan-line", name: "Scan line", description: "Moving horizontal line. CRT, retro, tech.", keyParams: "color, speed, opacity" },
  { primitive: "film-grain", name: "Film grain", description: "Subtle noise texture. Analog, cinematic.", keyParams: "intensity" },
];
