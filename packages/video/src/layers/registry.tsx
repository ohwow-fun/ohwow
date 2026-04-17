import React from "react";
import {
  Aurora,
  Bokeh,
  LightRays,
  ConstellationNet,
  WaveForm,
  GeometricShapes,
  Vignette,
  RippleRings,
  GradientWash,
  FlowFieldLayer,
  PulseRing,
  GlowOrb,
  NoiseGrid,
  ScanLine,
  FilmGrain,
  ParticleBurst,
  GridMorph,
  TextShadowTrail,
} from "../motion/generative";
import { VideoClipLayer } from "./VideoClipLayer";
import { CountUp } from "./semantic-primitives/CountUp";
import { BadgeReveal } from "./semantic-primitives/BadgeReveal";
import { VersusCard } from "./semantic-primitives/VersusCard";
import { BenchmarkBar } from "./semantic-primitives/BenchmarkBar";
import { SpecList } from "./semantic-primitives/SpecList";

export type PrimitiveComponent = React.FC<Record<string, unknown>>;

export interface PrimitiveCatalogEntry {
  name: string;
  paramWhitelist: readonly string[];
  description?: string;
  builtin: boolean;
}

interface RegistryEntry {
  component: PrimitiveComponent;
  paramWhitelist: ReadonlySet<string>;
  description?: string;
  builtin: boolean;
}

const registry = new Map<string, RegistryEntry>();

export class LayerPrimitiveConflictError extends Error {
  constructor(name: string) {
    super(`Layer primitive "${name}" is already registered. Call unregisterLayerPrimitive first if you intend to replace it.`);
    this.name = "LayerPrimitiveConflictError";
  }
}

function register(
  name: string,
  component: PrimitiveComponent,
  whitelist: readonly string[] | ReadonlySet<string>,
  description: string | undefined,
  builtin: boolean,
): void {
  if (registry.has(name)) throw new LayerPrimitiveConflictError(name);
  const set = whitelist instanceof Set ? whitelist : new Set(whitelist);
  registry.set(name, { component, paramWhitelist: set, description, builtin });
}

export function registerLayerPrimitive(
  name: string,
  component: PrimitiveComponent,
  paramWhitelist: readonly string[] | ReadonlySet<string>,
  description?: string,
): void {
  register(name, component, paramWhitelist, description, false);
}

export function unregisterLayerPrimitive(name: string): boolean {
  const entry = registry.get(name);
  if (!entry) return false;
  if (entry.builtin) {
    throw new Error(`Cannot unregister built-in primitive "${name}".`);
  }
  registry.delete(name);
  return true;
}

export function getLayerPrimitive(
  name: string,
): { component: PrimitiveComponent; paramWhitelist: ReadonlySet<string> } | undefined {
  const entry = registry.get(name);
  if (!entry) return undefined;
  return { component: entry.component, paramWhitelist: entry.paramWhitelist };
}

export function hasLayerPrimitive(name: string): boolean {
  return registry.has(name);
}

export function listLayerPrimitives(): PrimitiveCatalogEntry[] {
  return Array.from(registry.entries()).map(([name, e]) => ({
    name,
    paramWhitelist: Array.from(e.paramWhitelist),
    description: e.description,
    builtin: e.builtin,
  }));
}

// ─── Built-in registrations ─────────────────────────────────────────────────
// Param whitelists mirror what each component reads in motion/generative.tsx.

register("aurora", Aurora as PrimitiveComponent, ["colors", "speed", "opacity", "y"], "Slow-moving luminous bands with blur. Ethereal, calm.", true);
register("bokeh", Bokeh as PrimitiveComponent, ["count", "colors", "seed", "minSize", "maxSize", "speed"], "Soft out-of-focus circles drifting. Dreamy, depth.", true);
register("light-rays", LightRays as PrimitiveComponent, ["count", "color", "originX", "originY", "spread", "speed", "opacity"], "Crepuscular rays from a point. Divine, dramatic.", true);
register("constellation", ConstellationNet as PrimitiveComponent, ["nodeCount", "color", "seed", "speed", "lineOpacity", "dotSize"], "Nodes connected by faint lines. Network, intelligence.", true);
register("waveform", WaveForm as PrimitiveComponent, ["color", "amplitude", "frequency", "speed", "y", "opacity", "layers"], "Layered sine waves. Audio, rhythm, flow.", true);
register("geometric", GeometricShapes as PrimitiveComponent, ["count", "color", "seed", "speed", "opacity", "shapes"], "Rotating circles, squares, triangles. Structure, order.", true);
register("vignette", Vignette as PrimitiveComponent, ["intensity", "color"], "Edge darkening. Focus, cinematic.", true);
register("ripple", RippleRings as PrimitiveComponent, ["cx", "cy", "color", "count", "speed", "maxRadius", "opacity"], "Expanding concentric circles. Impact, signal.", true);
register("gradient-wash", GradientWash as PrimitiveComponent, ["colors", "speed", "angle", "opacity"], "Moving color gradient overlay. Mood, atmosphere.", true);
register("flow-field", FlowFieldLayer as PrimitiveComponent, ["count", "seed", "speed", "colors", "width", "height"], "Noise-driven particle swarm. Energy, organic.", true);
register("pulse-ring", PulseRing as PrimitiveComponent, ["cx", "cy", "radius", "color", "speed", "thickness"], "Single breathing ring. Heartbeat, life.", true);
register("glow-orb", GlowOrb as PrimitiveComponent, ["cx", "cy", "size", "color", "pulseSpeed"], "Soft radial glow. Warmth, presence.", true);
register("noise-grid", NoiseGrid as PrimitiveComponent, ["cols", "rows", "cellSize", "seed", "color", "speed"], "Grid cells with noise-driven opacity. Data, matrix.", true);
register("scan-line", ScanLine as PrimitiveComponent, ["color", "speed", "opacity"], "Moving horizontal line. CRT, retro, tech.", true);
register("film-grain", FilmGrain as PrimitiveComponent, ["intensity"], "Subtle noise texture. Analog, cinematic.", true);
register("particle-burst", ParticleBurst as PrimitiveComponent, ["count", "color", "seed", "speed", "size", "cx", "cy"], "Explosion of particles from center. Reveals, energy, impact.", true);
register("grid-morph", GridMorph as PrimitiveComponent, ["cols", "rows", "cellSize", "color", "seed", "speed", "morphIntensity"], "Morphing grid pattern. Data, tech, structure.", true);
register("text-shadow-trail", TextShadowTrail as PrimitiveComponent, ["text", "color", "trailColor", "trailCount", "speed", "fontSize"], "Text with trailing shadow copies. Motion, emphasis.", true);
register("video-clip", VideoClipLayer as PrimitiveComponent, ["src", "opacity", "blendMode", "fit", "muted"], "Generative mp4 clip resolved at render time by the configured video provider.", true);

// ─── Semantic primitives (2D) — carry real script content ──────────────
// These animate on a fixed timeline inside their enclosing scene. They
// respect ASMR easing by default. Use them when the narration names a
// concrete number / metric / badge; keep decorative primitives
// (aurora, grid-morph, ...) in the backdrop layer slots.
register("count-up", CountUp as PrimitiveComponent, ["target", "unit", "formatDecimals", "durationFrames", "fontSize", "color", "label", "labelColor", "position"], "Large number that animates 0 → target with ASMR easing. For concrete stats like '13%', '40 tok/s'.", true);
register("badge-reveal", BadgeReveal as PrimitiveComponent, ["text", "variant", "subtitle", "position", "fontSize", "revealAt"], "Text pill that pops in with soft scale + glow. For named metrics / tags / version labels.", true);
register("versus-card", VersusCard as PrimitiveComponent, ["before", "after", "label", "transitionAt", "transitionDuration", "accent"], "2D before/after comparison cards with a glowing divider. Lighter alternative to r3f.versus-cards.", true);
register("benchmark-bar", BenchmarkBar as PrimitiveComponent, ["value", "max", "label", "unit", "color", "track", "durationFrames", "fontSize", "width"], "Horizontal bar filling 0 → value with a large number readout. For benchmark scores, percentages.", true);
register("spec-list", SpecList as PrimitiveComponent, ["items", "heading", "pacing", "startAt", "align"], "Sequentially revealed key:value list. For model specs, feature rosters, pricing tiers.", true);

// Exposed position keys that auto-scale from [0,1] ratios to percentage strings.
export const POSITION_KEYS: ReadonlySet<string> = new Set(["cx", "cy", "originX", "originY", "y"]);
