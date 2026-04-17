/**
 * motion-beats-compiler — translates a scene's high-level `motion_beats`
 * list into concrete `kind` + `params` for the renderer.
 *
 * The LLM (via the Briefing / series prompt) emits scenes in this shape:
 *
 *   {
 *     id: "story-1",
 *     durationInFrames: 150,
 *     motion_graphic_prompt: "Show a 13% count-up bar with particles",
 *     motion_beats: [
 *       { primitive: "r3f.count-up-bar", params: { target: 13, unit: "%", label: "..." } },
 *       { primitive: "r3f.particle-cloud", params: { count: 500 } }
 *     ],
 *     params: { background: "#0a1020", motionProfile: "asmr" }  // scene-level (non-beat) params
 *   }
 *
 * and the compiler returns a render-ready scene:
 *
 *   {
 *     id: "story-1",
 *     kind: "r3f-scene",
 *     durationInFrames: 150,
 *     narration: "...",
 *     params: {
 *       background: "#0a1020",
 *       motionProfile: "asmr",
 *       primitives: [
 *         { primitive: "r3f.count-up-bar", params: {...} },
 *         { primitive: "r3f.particle-cloud", params: {...} }
 *       ]
 *     }
 *   }
 *
 * Scene kind is decided by beat namespace:
 *   - any "r3f.*" beat → kind "r3f-scene", beats dropped into params.primitives
 *   - all 2D beats    → kind "composable", beats dropped into params.visualLayers
 *
 * Mixed-namespace beats are not supported in v1. If a scene has both R3F
 * and 2D beats, the 2D ones are logged and dropped — R3F wins because
 * the scene kind can only be one or the other.
 *
 * Scenes WITHOUT motion_beats pass through unchanged.
 */
import type { Scene, MotionBeat } from "./types";

export interface CompilerReport {
  sceneId: string;
  applied: boolean;
  chosenKind?: "composable" | "r3f-scene";
  droppedBeats?: Array<{ primitive: string; reason: string }>;
  note?: string;
}

export interface CompileResult {
  scene: Scene;
  report: CompilerReport;
}

function isR3FBeat(beat: MotionBeat): boolean {
  return typeof beat.primitive === "string" && beat.primitive.startsWith("r3f.");
}

/**
 * Translate a single scene's motion_beats into kind + params. Scenes
 * without beats are returned unchanged with `applied: false`.
 */
export function compileSceneBeats(scene: Scene): CompileResult {
  if (!scene.motion_beats || scene.motion_beats.length === 0) {
    return { scene, report: { sceneId: scene.id, applied: false } };
  }

  // Scenes whose kind was already set to a codegen output (custom-*) bypass
  // the compiler — their TSX component draws the scene directly and the
  // motion_beats stay on the scene for provenance only.
  if (typeof scene.kind === "string" && scene.kind.startsWith("custom-")) {
    return {
      scene,
      report: {
        sceneId: scene.id,
        applied: false,
        note: `skipped — scene.kind "${scene.kind}" is a codegen kind; beats preserved for provenance`,
      },
    };
  }

  const beats = scene.motion_beats;
  const r3fBeats = beats.filter(isR3FBeat);
  const twoDBeats = beats.filter((b) => !isR3FBeat(b));

  // Decide target kind: R3F wins when present.
  const useR3F = r3fBeats.length > 0;
  const chosenKind: "composable" | "r3f-scene" = useR3F ? "r3f-scene" : "composable";

  // Collect dropped beats that don't match the chosen kind.
  const droppedBeats: Array<{ primitive: string; reason: string }> = [];
  if (useR3F && twoDBeats.length > 0) {
    for (const b of twoDBeats) {
      droppedBeats.push({
        primitive: b.primitive,
        reason: "2D primitive dropped — scene has R3F beats, cannot mix namespaces in v1",
      });
    }
  }

  const keepBeats = useR3F ? r3fBeats : twoDBeats;
  const beatEntries = keepBeats.map((b) => ({
    primitive: b.primitive,
    params: b.params ?? {},
  }));

  // Preserve any pre-existing scene-level params (camera, background,
  // motionProfile, environmentPreset, etc.) and layer the beats onto the
  // correct target field.
  const existingParams = (scene.params ?? {}) as Record<string, unknown>;
  const newParams: Record<string, unknown> = { ...existingParams };

  if (useR3F) {
    // Merge with any existing primitives[] in params.
    const existingPrimitives = Array.isArray(existingParams.primitives)
      ? (existingParams.primitives as Array<{ primitive: string; params?: Record<string, unknown> }>)
      : [];
    newParams.primitives = [...existingPrimitives, ...beatEntries];
  } else {
    const existingLayers = Array.isArray(existingParams.visualLayers)
      ? (existingParams.visualLayers as Array<{ primitive: string; params?: Record<string, unknown> }>)
      : [];
    newParams.visualLayers = [...existingLayers, ...beatEntries];
  }

  const compiled: Scene = {
    ...scene,
    kind: chosenKind,
    params: newParams,
  };

  return {
    scene: compiled,
    report: {
      sceneId: scene.id,
      applied: true,
      chosenKind,
      droppedBeats: droppedBeats.length ? droppedBeats : undefined,
      note: `${keepBeats.length} beat(s) compiled into params.${useR3F ? "primitives" : "visualLayers"}`,
    },
  };
}

/**
 * Walk a full VideoSpec's scenes array, compile each scene's beats if
 * present, and return the transformed scenes + a per-scene report.
 * Returns a new array; does not mutate the input.
 */
export function compileSpecBeats(scenes: Scene[]): {
  scenes: Scene[];
  reports: CompilerReport[];
} {
  const compiled: Scene[] = [];
  const reports: CompilerReport[] = [];
  for (const s of scenes) {
    const { scene, report } = compileSceneBeats(s);
    compiled.push(scene);
    reports.push(report);
  }
  return { scenes: compiled, reports };
}
