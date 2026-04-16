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
import type { VideoSpec, TransitionSpec, AudioRef } from "./spec/types";
import { totalDurationFrames } from "./spec/totalDuration";
import { renderScene } from "./scenes/registry";
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
  if (t.kind === "slide") {
    return linearTiming({ durationInFrames: t.durationInFrames });
  }
  return linearTiming({ durationInFrames: 0 });
}

function presentationFor(t: TransitionSpec) {
  if (t.kind === "fade") return fade();
  if (t.kind === "slide") return slide({ direction: t.direction });
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
    </AbsoluteFill>
  );
};
