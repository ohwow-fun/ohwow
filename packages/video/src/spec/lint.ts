import type { VideoSpec, AudioRef } from "./types";
import { safeParseVideoSpec } from "./schema";
import { hasSceneKind } from "../scenes/registry";
import { getLayerPrimitive } from "../layers/registry";
import { hasTransition } from "../transitions/registry";
import { totalDurationFrames } from "./totalDuration";

export type LintSeverity = "error" | "warning";

export interface LintIssue {
  code: string;
  severity: LintSeverity;
  message: string;
  path: string;
}

export interface LintResult {
  errors: LintIssue[];
  warnings: LintIssue[];
  ok: boolean;
}

export interface LintOptions {
  /** If true, `params` keys not in a primitive's whitelist become errors instead of warnings. */
  strictParams?: boolean;
}

function msToFrames(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

function checkAudioRef(
  ref: AudioRef,
  pathPrefix: string,
  totalFrames: number,
  out: LintIssue[],
): void {
  if (ref.startFrame >= totalFrames) {
    out.push({
      code: "audio/start-after-end",
      severity: "error",
      message: `AudioRef startFrame (${ref.startFrame}) is past the total composition duration (${totalFrames} frames).`,
      path: `${pathPrefix}.startFrame`,
    });
  }
  if (ref.durationFrames != null) {
    const end = ref.startFrame + ref.durationFrames;
    if (end > totalFrames) {
      out.push({
        code: "audio/overruns-composition",
        severity: "warning",
        message: `AudioRef ends at frame ${end} but composition is ${totalFrames} frames long. Will be clipped.`,
        path: `${pathPrefix}.durationFrames`,
      });
    }
  }
}

export function lintVideoSpec(
  input: unknown,
  options: LintOptions = {},
): LintResult {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  const parsed = safeParseVideoSpec(input);
  if (!parsed.ok) {
    for (const issue of parsed.issues) {
      errors.push({
        code: `schema/${issue.code ?? "invalid"}`,
        severity: "error",
        message: issue.message,
        path: issue.path.length ? issue.path.join(".") : "(root)",
      });
    }
    return { errors, warnings, ok: false };
  }

  const spec: VideoSpec = parsed.spec;
  const totalFrames = totalDurationFrames(spec);

  // ─── Scenes ───────────────────────────────────────────────────────────────
  spec.scenes.forEach((scene, i) => {
    const pathPrefix = `scenes[${i}]`;

    // Scene kind must be registered.
    if (!hasSceneKind(scene.kind)) {
      errors.push({
        code: "scene/unknown-kind",
        severity: "error",
        message: `Unknown scene kind "${scene.kind}". Register it via registerSceneKind() or use a built-in.`,
        path: `${pathPrefix}.kind`,
      });
    }

    // Narration vs. voiceDuration metadata: scene must be long enough to hold the narration.
    const voiceMs = scene.metadata?.voiceDurationMs;
    if (typeof voiceMs === "number" && voiceMs > 0) {
      const neededFrames = msToFrames(voiceMs, spec.fps);
      if (scene.durationInFrames < neededFrames) {
        errors.push({
          code: "scene/duration-shorter-than-voice",
          severity: "error",
          message: `Scene duration ${scene.durationInFrames}f is shorter than the voiceover (${neededFrames}f). Extend the scene or shorten the narration.`,
          path: `${pathPrefix}.durationInFrames`,
        });
      } else if (scene.durationInFrames < neededFrames + 6) {
        warnings.push({
          code: "scene/tight-voice-padding",
          severity: "warning",
          message: `Scene duration ${scene.durationInFrames}f leaves < 0.2s of padding after the ${neededFrames}f voiceover. Add some headroom.`,
          path: `${pathPrefix}.durationInFrames`,
        });
      }
    }

    // Narration without voiceDuration metadata is a soft hint (can't verify timing).
    if (scene.narration && scene.narration.trim().length > 0 && !voiceMs) {
      warnings.push({
        code: "scene/narration-without-voice-duration",
        severity: "warning",
        message: `Scene has narration but no metadata.voiceDurationMs. Lint can't verify duration fits the voiceover.`,
        path: `${pathPrefix}.metadata.voiceDurationMs`,
      });
    }

    // Caption bounds.
    (scene.captions ?? []).forEach((cap, ci) => {
      const end = cap.startFrame + cap.durationFrames;
      if (end > scene.durationInFrames) {
        errors.push({
          code: "caption/out-of-bounds",
          severity: "error",
          message: `Caption ends at frame ${end} but scene is ${scene.durationInFrames}f long.`,
          path: `${pathPrefix}.captions[${ci}].durationFrames`,
        });
      }
    });

    // Layer primitive checks. ComposableScene reads params.visualLayers; we
    // also tolerate a flat "layers" key so LLM outputs don't silently skip
    // validation.
    const layersSource =
      (scene.params as { visualLayers?: unknown })?.visualLayers
      ?? (scene.params as { layers?: unknown })?.layers;
    if (Array.isArray(layersSource)) {
      const key = (scene.params as Record<string, unknown>)?.visualLayers ? "visualLayers" : "layers";
      layersSource.forEach((layer, li) => {
        if (typeof layer !== "object" || layer === null) return;
        const primitive = (layer as { primitive?: unknown }).primitive;
        const layerParams = (layer as { params?: unknown }).params;
        if (typeof primitive !== "string") return;
        const entry = getLayerPrimitive(primitive);
        if (!entry) {
          errors.push({
            code: "layer/unknown-primitive",
            severity: "error",
            message: `Unknown layer primitive "${primitive}". Register via registerLayerPrimitive().`,
            path: `${pathPrefix}.params.${key}[${li}].primitive`,
          });
          return;
        }
        if (layerParams && typeof layerParams === "object") {
          const severity: LintSeverity = options.strictParams ? "error" : "warning";
          const bucket = options.strictParams ? errors : warnings;
          for (const k of Object.keys(layerParams as Record<string, unknown>)) {
            if (!entry.paramWhitelist.has(k)) {
              bucket.push({
                code: "layer/unknown-param",
                severity,
                message: `Param "${k}" is not in the whitelist for primitive "${primitive}" (${Array.from(entry.paramWhitelist).join(", ")}).`,
                path: `${pathPrefix}.params.${key}[${li}].params.${k}`,
              });
            }
          }
        }
      });
    }
  });

  // ─── Transitions ──────────────────────────────────────────────────────────
  spec.transitions.forEach((t, i) => {
    const pathPrefix = `transitions[${i}]`;
    if (t.kind === "none") return;
    if (!hasTransition(t.kind)) {
      errors.push({
        code: "transition/unknown-kind",
        severity: "error",
        message: `Unknown transition kind "${t.kind}". Register via registerTransition() or use "none".`,
        path: `${pathPrefix}.kind`,
      });
      return;
    }
    const dur = (t as { durationInFrames?: number }).durationInFrames;
    if (typeof dur !== "number" || dur <= 0) {
      errors.push({
        code: "transition/missing-duration",
        severity: "error",
        message: `Transition "${t.kind}" needs a positive durationInFrames.`,
        path: `${pathPrefix}.durationInFrames`,
      });
      return;
    }
    // Overlap must be at most half of each adjacent scene.
    const left = spec.scenes[i]?.durationInFrames ?? 0;
    const right = spec.scenes[i + 1]?.durationInFrames ?? 0;
    const minAdjacent = Math.min(left, right);
    if (dur * 2 > minAdjacent) {
      errors.push({
        code: "transition/overlap-too-long",
        severity: "error",
        message: `Transition overlap (${dur}f) is more than half of the shorter adjacent scene (${minAdjacent}f). This will consume the entire scene.`,
        path: `${pathPrefix}.durationInFrames`,
      });
    }
  });

  if (spec.transitions.length > spec.scenes.length - 1) {
    warnings.push({
      code: "transition/extra-entries",
      severity: "warning",
      message: `transitions has ${spec.transitions.length} entries but only ${Math.max(0, spec.scenes.length - 1)} are needed (one between each pair of scenes).`,
      path: "transitions",
    });
  }

  // ─── Audio refs ───────────────────────────────────────────────────────────
  if (spec.music) checkAudioRef(spec.music, "music", totalFrames, warnings);
  spec.voiceovers.forEach((v, i) => {
    checkAudioRef(v, `voiceovers[${i}]`, totalFrames, warnings);
    // Also add hard errors for start-past-end.
    if (v.startFrame >= totalFrames) {
      errors.push({
        code: "audio/voice-start-after-end",
        severity: "error",
        message: `Voiceover ${i} starts at frame ${v.startFrame} but composition is ${totalFrames}f long.`,
        path: `voiceovers[${i}].startFrame`,
      });
    }
  });

  // ─── FPS sanity ───────────────────────────────────────────────────────────
  if (spec.fps < 12) {
    warnings.push({
      code: "fps/too-low",
      severity: "warning",
      message: `fps=${spec.fps} is unusually low. Typical values are 24, 30, or 60.`,
      path: "fps",
    });
  } else if (spec.fps > 120) {
    warnings.push({
      code: "fps/too-high",
      severity: "warning",
      message: `fps=${spec.fps} is unusually high. Typical values are 24, 30, or 60.`,
      path: "fps",
    });
  }

  // ─── Dimensions sanity ────────────────────────────────────────────────────
  if (spec.width % 2 !== 0 || spec.height % 2 !== 0) {
    errors.push({
      code: "dimensions/odd",
      severity: "error",
      message: `Width (${spec.width}) and height (${spec.height}) must both be even for h264 encoding.`,
      path: "width",
    });
  }

  return { errors, warnings, ok: errors.length === 0 };
}

export function formatLintIssue(issue: LintIssue): string {
  const tag = issue.severity === "error" ? "error" : "warn ";
  return `[${tag}] ${issue.path}  ${issue.code}\n        ${issue.message}`;
}

export function formatLintResult(result: LintResult): string {
  const lines: string[] = [];
  for (const e of result.errors) lines.push(formatLintIssue(e));
  for (const w of result.warnings) lines.push(formatLintIssue(w));
  if (result.ok && result.warnings.length === 0) {
    lines.push("Spec is clean. 0 errors, 0 warnings.");
  } else {
    lines.push(`\n${result.errors.length} error${result.errors.length === 1 ? "" : "s"}, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}.`);
  }
  return lines.join("\n");
}
