import { z } from "zod";
import type { VideoSpec } from "./types";

const BrandTokensSchema = z.object({
  colors: z.record(z.string(), z.string()),
  fonts: z.object({
    sans: z.string().min(1),
    mono: z.string().min(1),
    display: z.string().min(1),
  }),
  glass: z.object({
    background: z.string().min(1),
    border: z.string().min(1),
    borderRadius: z.number().nonnegative(),
    backdropFilter: z.string().min(1),
  }),
});

const AudioRefSchema = z.object({
  src: z.string().min(1),
  startFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive().optional(),
  volume: z.number().min(0).max(4).optional(),
});

const CaptionSpecSchema = z.object({
  text: z.string(),
  highlight: z.array(z.string()).optional(),
  startFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
});

const VideoPaletteSchema = z.object({
  seedHue: z.number().min(0).lt(360),
  harmony: z.enum(["analogous", "complementary", "triadic", "split"]),
  mood: z.enum(["dark", "warm", "cool", "electric", "forest", "sunset", "midnight"]),
});

// Transitions are an open set: core kinds have stricter shapes, custom kinds
// can register via the transitions registry. We validate the envelope here
// and defer kind-specific shape checks to the linter.
const TransitionSpecSchema = z
  .object({
    kind: z.string().min(1),
    durationInFrames: z.number().int().nonnegative().optional(),
    direction: z.string().optional(),
    spring: z
      .object({
        damping: z.number(),
        durationRestThreshold: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

const MotionBeatSchema = z.object({
  primitive: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  at: z.number().int().nonnegative().optional(),
  duration: z.number().int().positive().optional(),
});

// Scenes are an open set: scene kinds register at runtime. We validate only
// the envelope; per-kind params are validated by the scene component itself.
const SceneSchema = z.object({
  id: z.string().min(1),
  // Optional — beats-driven scenes omit kind and the compiler sets it.
  kind: z.string().min(1).optional(),
  durationInFrames: z.number().int().positive(),
  params: z.record(z.string(), z.unknown()).optional(),
  captions: z.array(CaptionSpecSchema).optional(),
  narration: z.string().optional(),
  motion_graphic_prompt: z.string().optional(),
  motion_beats: z.array(MotionBeatSchema).optional(),
  custom_codegen: z.boolean().optional(),
  metadata: z
    .object({
      voiceDurationMs: z.number().positive().optional(),
    })
    .passthrough()
    .optional(),
});

export const VideoSpecSchema = z.object({
  id: z.string().min(1),
  version: z.literal(1),
  fps: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  brand: BrandTokensSchema,
  palette: VideoPaletteSchema.optional(),
  music: AudioRefSchema.optional(),
  voiceovers: z.array(AudioRefSchema),
  transitions: z.array(TransitionSpecSchema),
  scenes: z.array(SceneSchema).min(1),
});

export type VideoSpecParseResult =
  | { ok: true; spec: VideoSpec }
  | { ok: false; issues: z.core.$ZodIssue[] };

export function parseVideoSpec(input: unknown): VideoSpec {
  return VideoSpecSchema.parse(input) as unknown as VideoSpec;
}

export function safeParseVideoSpec(input: unknown): VideoSpecParseResult {
  const result = VideoSpecSchema.safeParse(input);
  if (result.success) return { ok: true, spec: result.data as unknown as VideoSpec };
  return { ok: false, issues: result.error.issues };
}

export {
  BrandTokensSchema,
  AudioRefSchema,
  CaptionSpecSchema,
  VideoPaletteSchema,
  TransitionSpecSchema,
  SceneSchema,
};
