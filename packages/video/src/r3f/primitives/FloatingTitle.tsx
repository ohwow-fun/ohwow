/**
 * r3f.floating-title — large clean title + optional subtitle floating
 * in 3D space with NO container/panel behind them. White text with a
 * soft dark outline for legibility against a cloudy/dark backdrop.
 *
 * Kinetic reveal on the main title: each character drops from above
 * with a spring overshoot, staggered. Subtitle fades in as one unit
 * once the title has settled.
 *
 * Use against a black background with r3f.color-fog for the "cloudy
 * colorful but darkened" look that the Briefing intro/outro target.
 *
 * Params:
 *   text:        string — main title (required)
 *   subtitle?:   string — optional smaller line below title
 *   titleSize?:  number — world-units font size for title (default 1.1)
 *   subtitleSize?: number — font size for subtitle (default 0.36)
 *   titleColor?: string — default pure white #ffffff
 *   subtitleColor?: string — default soft white #d8dfe8
 *   position?:   [x, y, z] — default [0, 0, 0]
 *   subtitleOffsetY?: number — vertical gap below title (default -0.85)
 *   kineticDelayFrames?: number — frame the first letter enters (default 0)
 *   kineticStaggerFrames?: number — between letters (default 3)
 *   subtitleDelayFrames?: number — frame the subtitle fades in (default 36)
 *   subtitleFadeFrames?: number — subtitle fade duration (default 18)
 */
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring, Easing, staticFile } from "remotion";
import { Text } from "@react-three/drei";

interface FloatingTitleProps {
  text?: string;
  subtitle?: string;
  titleSize?: number;
  subtitleSize?: number;
  titleColor?: string;
  subtitleColor?: string;
  position?: [number, number, number];
  subtitleOffsetY?: number;
  kineticDelayFrames?: number;
  kineticStaggerFrames?: number;
  subtitleDelayFrames?: number;
  subtitleFadeFrames?: number;
  maxWidth?: number;
  /** drei Text font URL (TTF/OTF/WOFF) — defaults to Smooch Sans ExtraBold. */
  titleFont?: string;
  /** Separate font for subtitle (default: lighter weight Smooch Sans Bold). */
  subtitleFont?: string;
  /** Letter spacing for the title (default 0.02 for Smooch Sans condensed feel). */
  titleLetterSpacing?: number;
  motionProfile?: string;
}

// Per-char advance LUT tuned for Smooch Sans ExtraBold — a tall
// condensed display sans. Narrower than the drei default across the
// board, so advances are pulled in.
function charAdvanceFraction(ch: string): number {
  if (ch === " ") return 0.26;
  const u = ch.toUpperCase();
  // Widest glyphs (still relatively narrow in Smooch's condensed shape).
  if ("MWO".includes(u)) return 0.58;
  // Wide.
  if ("ABCDGHKNQRU&".includes(u)) return 0.48;
  // Medium.
  if ("EFLPSTVXYZ?!".includes(u)) return 0.42;
  // Narrow.
  if ("IJ1.,'-·".includes(u)) return 0.22;
  // Default for unknowns (digits, etc).
  return 0.44;
}

export const FloatingTitle: React.FC<FloatingTitleProps> = ({
  text = "",
  subtitle,
  titleSize = 1.1,
  subtitleSize = 0.36,
  titleColor = "#ffffff",
  subtitleColor = "#d8dfe8",
  position = [0, 0, 0],
  subtitleOffsetY = -0.9,
  kineticDelayFrames = 0,
  kineticStaggerFrames = 3,
  subtitleDelayFrames = 36,
  subtitleFadeFrames = 18,
  maxWidth = 14,
  titleFont,
  subtitleFont,
  titleLetterSpacing = 0.02,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Default to Smooch Sans (the landing-page display font). Callers can
  // override via titleFont/subtitleFont for series-specific typography.
  const resolvedTitleFont = useMemo(
    () => titleFont ?? staticFile("fonts/SmoochSans-ExtraBold.ttf"),
    [titleFont],
  );
  const resolvedSubtitleFont = useMemo(
    () => subtitleFont ?? staticFile("fonts/SmoochSans-Bold.ttf"),
    [subtitleFont],
  );

  // Lay out title characters horizontally.
  const chars = Array.from(text);
  const advances = chars.map((c) => titleSize * charAdvanceFraction(c));
  const totalWidth = advances.reduce((a, b) => a + b, 0);
  const fitScale = totalWidth > maxWidth ? maxWidth / totalWidth : 1;
  const scaledSize = titleSize * fitScale;
  const scaledAdv = advances.map((a) => a * fitScale);
  const startX = position[0] - (totalWidth * fitScale) / 2;

  // Subtitle fade progress.
  const subtitleOpacity = subtitle
    ? interpolate(
        frame,
        [subtitleDelayFrames, subtitleDelayFrames + subtitleFadeFrames],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) },
      )
    : 0;

  return (
    <group>
      {/* Kinetic title letters */}
      {chars.map((ch, i) => {
        const charX =
          startX +
          scaledAdv.slice(0, i).reduce((a, b) => a + b, 0) +
          scaledAdv[i] / 2;
        const revealFrame = kineticDelayFrames + i * kineticStaggerFrames;
        const progress = spring({
          frame: frame - revealFrame,
          fps,
          config: { damping: 12, mass: 0.6, stiffness: 140 },
        });
        const dropY = interpolate(progress, [0, 1], [titleSize * 1.2, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const opacity = interpolate(progress, [0, 0.35, 1], [0, 0.6, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        });
        const seeded = (i * 9301 + 49297) % 233280;
        const jitterRad = ((seeded / 233280) - 0.5) * 0.1 * (1 - progress);
        if (opacity <= 0.01) return null;
        return (
          <Text
            key={`ft-${i}`}
            font={resolvedTitleFont}
            position={[charX, position[1] + dropY, position[2]]}
            rotation={[0, 0, jitterRad]}
            fontSize={scaledSize}
            color={titleColor}
            anchorX="center"
            anchorY="middle"
            fillOpacity={opacity}
            letterSpacing={titleLetterSpacing}
            outlineWidth={scaledSize * 0.01}
            outlineColor="#000000"
            outlineOpacity={0.4}
          >
            {ch}
          </Text>
        );
      })}

      {/* Subtitle — fades in after title settles, no container */}
      {subtitle && subtitleOpacity > 0.01 && (
        <Text
          font={resolvedSubtitleFont}
          position={[position[0], position[1] + subtitleOffsetY, position[2]]}
          fontSize={subtitleSize}
          color={subtitleColor}
          anchorX="center"
          anchorY="middle"
          fillOpacity={subtitleOpacity}
          letterSpacing={0.18}
          maxWidth={maxWidth}
          textAlign="center"
          outlineWidth={subtitleSize * 0.02}
          outlineColor="#000000"
          outlineOpacity={0.4}
        >
          {subtitle}
        </Text>
      )}
    </group>
  );
};
