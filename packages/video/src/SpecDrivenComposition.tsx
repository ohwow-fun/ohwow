import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import {
  TransitionSeries,
  springTiming,
  linearTiming,
  type TransitionTiming,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import type { VideoSpec, TransitionSpec, AudioRef, CaptionSpec } from "./spec/types";
import { totalDurationFrames } from "./spec/totalDuration";
import { renderScene } from "./scenes/registry";
import { Caption } from "./components/Caption";
import { loadBrandFonts } from "./fonts";

loadBrandFonts();

function resolveSrc(src: string): string {
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")) {
    return src;
  }
  return staticFile(src);
}

function timingFor(t: TransitionSpec): TransitionTiming {
  if (t.kind === "fade") {
    return t.spring
      ? springTiming({
          config: { damping: t.spring.damping },
          durationInFrames: t.durationInFrames,
          durationRestThreshold: t.spring.durationRestThreshold ?? 0.001,
        })
      : linearTiming({ durationInFrames: t.durationInFrames });
  }
  if (t.kind === "slide" || t.kind === "wipe") {
    return linearTiming({ durationInFrames: t.durationInFrames });
  }
  return linearTiming({ durationInFrames: 0 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function presentationFor(t: TransitionSpec): any {
  if (t.kind === "fade") return fade();
  if (t.kind === "slide") return slide({ direction: t.direction });
  if (t.kind === "wipe") return wipe({ direction: t.direction });
  return fade();
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
    if (i < spec.scenes.length - 1 && t && t.kind !== "none") {
      cursor -= t.durationInFrames;
    }
  }
  return starts;
}

/**
 * Auto-generate captions from scene narrations when scene.captions is absent
 * but the workspace author stored a narration string. Splits the narration into
 * 1-3 beats, distributed evenly across the scene duration.
 */
function autoCaptions(narration: string, durationFrames: number): CaptionSpec[] {
  if (!narration || durationFrames < 30) return [];
  const sentences = narration
    .replace(/([.!?])\s+/g, "$1|")
    .split("|")
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (sentences.length === 0) return [];

  const totalChars = sentences.reduce((a, s) => a + s.length, 0);
  const captions: CaptionSpec[] = [];
  let frameOffset = 5;
  const GAP = 5;

  for (const sentence of sentences) {
    const proportion = sentence.length / totalChars;
    const dur = Math.max(30, Math.round((durationFrames - 10) * proportion) - GAP);
    const words = sentence.split(/\s+/);
    const highlight = words.length >= 4
      ? [words[words.length - 1].replace(/[.,!?]$/, "")]
      : undefined;
    captions.push({
      text: sentence,
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
    const caps = scene.captions?.length
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

export const SpecDrivenComposition: React.FC<VideoSpec> = (spec) => {
  const totalFrames = totalDurationFrames(spec);
  const { scenes, transitions, voiceovers, music } = spec;

  return (
    <AbsoluteFill>
      {music && (
        <Sequence from={music.startFrame} durationInFrames={totalFrames - music.startFrame}>
          <Audio src={resolveSrc(music.src)} volume={music.volume ?? 1} />
        </Sequence>
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
          if (i < scenes.length - 1 && t && t.kind !== "none") {
            parts.push(
              <TransitionSeries.Transition
                key={`tr-${scene.id}`}
                presentation={presentationFor(t)}
                timing={timingFor(t)}
              />,
            );
          }
          return parts;
        })}
      </TransitionSeries>

      <CaptionLayer spec={spec} totalFrames={totalFrames} />
    </AbsoluteFill>
  );
};
