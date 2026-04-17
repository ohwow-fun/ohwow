import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { TransitionSeries } from "@remotion/transitions";
import type { VideoSpec, AudioRef, CaptionSpec } from "./spec/types";
import { totalDurationFrames } from "./spec/totalDuration";
import { renderScene } from "./scenes/registry";
import { resolveTransition } from "./transitions/registry";
import { Caption } from "./components/Caption";
import { loadBrandFonts } from "./fonts";
import { compileSpecBeats } from "./spec/motion-beats-compiler";

loadBrandFonts();

function resolveSrc(src: string): string {
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")) {
    return src;
  }
  return staticFile(src);
}

const AudioLayer: React.FC<{ refs: AudioRef[]; totalFrames: number }> = ({
  refs,
  totalFrames,
}) => (
  <>
    {refs.map((ref, i) => {
      const src = resolveSrc(ref.src);
      const durationInFrames = ref.durationFrames ?? totalFrames - ref.startFrame;
      return (
        <Sequence
          key={`${src}-${i}`}
          from={ref.startFrame}
          durationInFrames={Math.max(1, durationInFrames)}
        >
          <Audio src={src} volume={ref.volume ?? 1} />
        </Sequence>
      );
    })}
  </>
);

/**
 * Smoothstep (cubic ease-in-out). Linear ramps at the edges of a duck make
 * the envelope audibly "clip" into and out of steady state; smoothstep's
 * zero-derivative endpoints round those corners so a large dynamic swing
 * (e.g. 0.9 → 0.12) still sounds like a compressor, not a volume knob being
 * yanked.
 */
function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Sidechain-style ducking. Returns a frame-indexed volume function where the
 * music sits at `baseVolume` during silent gaps and dips to `duckedVolume`
 * whenever any voiceover window is active. Attack/release ramps are eased
 * with smoothstep so the envelope is clean even across a wide dynamic range.
 *
 * Frames passed to the returned function are Sequence-relative (i.e., 0 at
 * the start of the music Sequence); internally we shift by `musicStartFrame`
 * so voice windows can be compared in absolute-composition time.
 *
 * Voice windows that lack a durationFrames are skipped — without an explicit
 * end frame we can't honor a release ramp, and defaulting to "active until
 * composition end" would leave music ducked for the whole tail.
 */
function buildMusicVolume(params: {
  baseVolume: number;
  duckedVolume: number;
  attackFrames: number;
  releaseFrames: number;
  musicStartFrame: number;
  voiceWindows: Array<{ start: number; end: number }>;
}): (f: number) => number {
  const { baseVolume, duckedVolume, attackFrames, releaseFrames, musicStartFrame, voiceWindows } = params;
  if (voiceWindows.length === 0 || duckedVolume >= baseVolume) {
    return () => baseVolume;
  }
  return (f: number): number => {
    const absoluteFrame = musicStartFrame + f;
    let target = baseVolume;
    for (const { start, end } of voiceWindows) {
      let duckAmount = 0;
      if (absoluteFrame >= start - attackFrames && absoluteFrame < start) {
        duckAmount = attackFrames === 0
          ? 1
          : smoothstep((absoluteFrame - (start - attackFrames)) / attackFrames);
      } else if (absoluteFrame >= start && absoluteFrame < end) {
        duckAmount = 1;
      } else if (absoluteFrame >= end && absoluteFrame < end + releaseFrames) {
        duckAmount = releaseFrames === 0
          ? 0
          : smoothstep(1 - (absoluteFrame - end) / releaseFrames);
      }
      if (duckAmount > 0) {
        const vol = baseVolume + (duckedVolume - baseVolume) * duckAmount;
        if (vol < target) target = vol;
      }
    }
    return target;
  };
}

const MusicLayer: React.FC<{
  music: AudioRef;
  voiceovers: AudioRef[];
  totalFrames: number;
}> = ({ music, voiceovers, totalFrames }) => {
  const baseVolume = music.volume ?? 1;
  // Duck to a fixed target in the 0.08-0.12 band regardless of base, so the
  // voice sits on top by the same headroom margin even when music is loud.
  // Capped by 40% of base so a very quiet base (e.g. 0.2) doesn't mean
  // ducking UP.
  const duckedVolume = Math.min(0.12, baseVolume * 0.4);
  const voiceWindows = voiceovers
    .filter((v) => typeof v.durationFrames === "number")
    .map((v) => ({
      start: v.startFrame,
      end: v.startFrame + (v.durationFrames as number),
    }));
  const volumeFn = buildMusicVolume({
    baseVolume,
    duckedVolume,
    // Longer ramps than a typical sidechain because we're traversing a much
    // wider dynamic range (up to ~8x). 15 frames in / 30 out at 30fps ≈
    // 500ms attack, 1s release — musical without letting voice onsets peek
    // through the head of the duck.
    attackFrames: 15,
    releaseFrames: 30,
    musicStartFrame: music.startFrame,
    voiceWindows,
  });
  return (
    <Sequence
      from={music.startFrame}
      durationInFrames={Math.max(1, totalFrames - music.startFrame)}
    >
      <Audio src={resolveSrc(music.src)} volume={volumeFn} loop />
    </Sequence>
  );
};

/**
 * Compute the composition-time frame offset where each scene visually begins,
 * accounting for transition overlap. Used to place captions at absolute time.
 */
function sceneStartFrames(spec: VideoSpec): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (let i = 0; i < spec.scenes.length; i++) {
    starts.push(cursor);
    cursor += spec.scenes[i].durationInFrames;
    const t = spec.transitions[i];
    // Overlap only if the transition actually resolves to a registered builder
    // (kind !== "none" and kind is registered). Unregistered custom kinds
    // degrade to no-overlap, matching the render-path behavior.
    if (i < spec.scenes.length - 1 && t && t.kind !== "none" && resolveTransition(t)) {
      cursor -= typeof t.durationInFrames === "number" ? t.durationInFrames : 0;
    }
  }
  return starts;
}

/**
 * Split a sentence into phrase-length chunks. Long sentences (>MAX_WORDS)
 * are broken at natural phrase boundaries: commas, em-dashes, and
 * coordinating conjunctions (", and", ", with", ", but", ", so"). Each
 * chunk stays readable-at-a-glance (≤ MAX_WORDS words, ≤ 2 lines on a
 * 1920-wide canvas at fontSize 56).
 */
function splitIntoPhrases(sentence: string): string[] {
  const MAX_WORDS = 14;
  const words = sentence.split(/\s+/);
  if (words.length <= MAX_WORDS) return [sentence];

  // Try comma splits first — highest-quality break points.
  // Keep the comma on the LEFT phrase so the reader parses the pause.
  const commaPieces = sentence.split(/(?<=,)\s+/).map((s) => s.trim()).filter(Boolean);
  if (commaPieces.length > 1 && commaPieces.every((p) => p.split(/\s+/).length <= MAX_WORDS + 3)) {
    return mergeShortPieces(commaPieces, MAX_WORDS);
  }

  // Try em-dash / en-dash splits.
  const dashPieces = sentence.split(/\s*[—–]\s*/).map((s) => s.trim()).filter(Boolean);
  if (dashPieces.length > 1) {
    return mergeShortPieces(dashPieces, MAX_WORDS);
  }

  // Fall back to conjunction splits (" and ", " with ", " but ", " so ").
  // Keep the conjunction at the START of the right phrase for readability.
  const conjRe = /\s+(and|with|but|so|yet|plus)\s+/;
  const conjMatch = sentence.match(conjRe);
  if (conjMatch && conjMatch.index !== undefined) {
    const left = sentence.slice(0, conjMatch.index).trim();
    const right = sentence.slice(conjMatch.index + 1).trim();
    return [left, right];
  }

  // Last resort: chunk every MAX_WORDS words hard.
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += MAX_WORDS) {
    chunks.push(words.slice(i, i + MAX_WORDS).join(" "));
  }
  return chunks;
}

/**
 * Merge adjacent phrase pieces so each chunk is ≥ ~5 words. Prevents
 * staccato one-word captions ("The model,", "which ships...") by
 * back-merging tiny leading fragments.
 */
function mergeShortPieces(pieces: string[], maxWords: number): string[] {
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    const pWords = p.split(/\s+/).length;
    const lastWords = last ? last.split(/\s+/).length : 0;
    if (last && (lastWords < 5 || pWords < 5) && lastWords + pWords <= maxWords + 3) {
      out[out.length - 1] = `${last} ${p}`;
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Auto-generate captions from scene narrations when scene.captions is absent
 * but the workspace author stored a narration string. Splits the narration
 * into sentences, then splits long sentences into phrase-length chunks so
 * no single caption exceeds ~14 words (≤ 2 lines on 1920-wide canvas).
 * Chunks are distributed proportionally across the scene duration by
 * character count.
 */
function autoCaptions(narration: string, durationFrames: number): CaptionSpec[] {
  if (!narration || durationFrames < 30) return [];
  const sentences = narration
    .replace(/([.!?])\s+/g, "$1|")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length === 0) return [];

  // Expand long sentences into phrase-length chunks.
  const chunks: string[] = [];
  for (const sentence of sentences) {
    chunks.push(...splitIntoPhrases(sentence));
  }

  const totalChars = chunks.reduce((a, s) => a + s.length, 0);
  const captions: CaptionSpec[] = [];
  let frameOffset = 5;
  const GAP = 3;

  for (const chunk of chunks) {
    const proportion = chunk.length / totalChars;
    const dur = Math.max(30, Math.round((durationFrames - 10) * proportion) - GAP);
    const words = chunk.split(/\s+/);
    const highlight = words.length >= 4
      ? [words[words.length - 1].replace(/[.,!?]$/, "")]
      : undefined;
    captions.push({
      text: chunk,
      highlight,
      startFrame: frameOffset,
      durationFrames: dur,
    });
    frameOffset += dur + GAP;
  }
  return captions;
}

const CaptionLayer: React.FC<{ spec: VideoSpec; totalFrames: number }> = ({
  spec,
  totalFrames,
}) => {
  const starts = sceneStartFrames(spec);
  const allCaptions: Array<CaptionSpec & { globalStart: number }> = [];

  spec.scenes.forEach((scene, i) => {
    const sceneStart = starts[i];
    // A scene that explicitly sets captions — even to an empty array —
    // opts out of auto-caption generation from its narration. This lets
    // signature intro/outro scenes that carry their own on-frame title
    // text (e.g. r3f.floating-title) suppress captions that would
    // otherwise collide with the floating subtitle.
    const caps = scene.captions !== undefined
      ? scene.captions
      : autoCaptions(
          (scene as { narration?: string }).narration ?? "",
          scene.durationInFrames,
        );
    for (const c of caps) {
      allCaptions.push({
        ...c,
        globalStart: sceneStart + c.startFrame,
      });
    }
  });

  return (
    <>
      {allCaptions.map((c, i) => (
        <Caption
          key={i}
          text={c.text}
          highlight={c.highlight}
          startFrame={c.globalStart}
          durationFrames={c.durationFrames}
        />
      ))}
    </>
  );
};

export const SpecDrivenComposition: React.FC<VideoSpec> = (rawSpec) => {
  // Compile any motion_beats on scenes into the render-ready shape so direct
  // `remotion render --props=beats-spec.json` works without the compose
  // pipeline. Scenes with no beats pass through unchanged.
  const spec = React.useMemo<VideoSpec>(() => {
    if (!rawSpec.scenes.some((s) => Array.isArray((s as { motion_beats?: unknown[] }).motion_beats))) {
      return rawSpec;
    }
    const { scenes: compiled } = compileSpecBeats(rawSpec.scenes);
    return { ...rawSpec, scenes: compiled };
  }, [rawSpec]);
  const totalFrames = totalDurationFrames(spec);
  const { scenes, transitions, voiceovers, music } = spec;

  return (
    <AbsoluteFill>
      {music && (
        <MusicLayer music={music} voiceovers={voiceovers} totalFrames={totalFrames} />
      )}
      <AudioLayer refs={voiceovers} totalFrames={totalFrames} />

      <TransitionSeries>
        {scenes.map((scene, i) => {
          const parts: React.ReactElement[] = [];
          parts.push(
            <TransitionSeries.Sequence
              key={`seq-${scene.id}`}
              durationInFrames={scene.durationInFrames}
            >
              {renderScene(scene)}
            </TransitionSeries.Sequence>,
          );
          const t = transitions[i];
          if (i < scenes.length - 1 && t) {
            const resolved = resolveTransition(t);
            if (resolved) {
              parts.push(
                <TransitionSeries.Transition
                  key={`tr-${scene.id}`}
                  presentation={resolved.presentation}
                  timing={resolved.timing}
                />,
              );
            }
          }
          return parts;
        })}
      </TransitionSeries>

      <CaptionLayer spec={spec} totalFrames={totalFrames} />
    </AbsoluteFill>
  );
};
