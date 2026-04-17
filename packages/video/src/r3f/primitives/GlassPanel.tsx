/**
 * r3f.glass-panel — a frosted glass slab that refracts the scene
 * behind it. Acts as a floating container for caption text or model
 * metadata. The refraction + subtle caustic feel is the ASMR money shot.
 *
 * Legibility: an inset darker backdrop sits BEHIND the text inside the
 * glass so subtitles don't drown in HDRI transmission. Glass tint is
 * subtle — too much transmission and the env map renders as literal
 * background.
 *
 * Params:
 *   width?:    number (default 5.6)
 *   height?:   number (default 2.6)
 *   depth?:    number (default 0.14)
 *   position?: [x, y, z] (default [0, 0, 0])
 *   rotation?: [rx, ry, rz] radians (default [0, 0, 0])
 *   tint?:     string — subtle color tint for the glass (default #d8e8ff)
 *   text?:     string — large text on the front face
 *   textColor?: string (default #0a1629)
 *   subtitle?: string
 *   subtitleColor?: string (default #2a3a55)
 *   idleFloat?: boolean — gentle Y oscillation (default true)
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring, Easing } from "remotion";
import { Text } from "@react-three/drei";
import { getMotionProfile } from "../../motion/asmr";

interface GlassPanelProps {
  width?: number;
  height?: number;
  depth?: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  tint?: string;
  text?: string;
  textColor?: string;
  subtitle?: string;
  subtitleColor?: string;
  idleFloat?: boolean;
  motionProfile?: string;
  /**
   * When true, the main text animates in letter-by-letter with a
   * staggered drop-from-above + spring settle. Leaves the subtitle
   * alone (subtitle just fades in). Designed for the intro/outro
   * hero moment so each letter has kinetic weight.
   */
  kineticType?: boolean;
  /** Frame offset at which the kinetic reveal begins (default 0). */
  kineticDelayFrames?: number;
  /** Frames between successive letter entries (default 3). */
  kineticStaggerFrames?: number;
}

export const GlassPanel: React.FC<GlassPanelProps> = ({
  width = 5.6,
  height = 2.6,
  depth = 0.14,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  tint = "#d8e8ff",
  text,
  textColor = "#0a1629",
  subtitle,
  subtitleColor = "#1a2238",
  idleFloat = true,
  motionProfile,
  kineticType = false,
  kineticDelayFrames = 0,
  kineticStaggerFrames = 3,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const profile = getMotionProfile(motionProfile);

  const t = frame / fps;
  const yFloat = idleFloat && profile.breathAmp > 0
    ? Math.sin(t * 0.5) * 0.08
    : 0;

  // Layout maths. Main text sits in the upper 55% of the panel,
  // subtitle sits in the lower 25% with its own backing band so the
  // two don't overlap even when main text wraps.
  const textSize = height * 0.28;
  const subtitleSize = height * 0.13;
  // Backing plane LARGER than the glass so transmission never refracts
  // pure HDRI environment through the edges of the slab.
  const bandWidth = width * 1.08;
  const bandHeight = height * 1.08;
  // Title and subtitle packed closer vertically so the panel doesn't
  // feel empty between them. Title sits just above center; subtitle
  // just below, with its own inset band.
  const textY = height * 0.1;
  const subtitleY = -height * 0.26;

  return (
    <group position={[position[0], position[1] + yFloat, position[2]]} rotation={rotation}>
      {/* Frosted contrast band BEHIND the glass — sits just behind the
          glass front face, gives the text something solid to read
          against instead of HDRI transmission. Nearly opaque so the
          env map's marina/studio imagery doesn't bleed through onto
          the caption area. */}
      <mesh position={[0, 0, -depth * 0.6]}>
        <planeGeometry args={[bandWidth, bandHeight]} />
        <meshStandardMaterial
          color={tint}
          roughness={0.55}
          metalness={0.08}
          transparent={false}
        />
      </mesh>

      {/* Glossy "glass overlay" — we dropped MeshTransmissionMaterial
          because it samples the HDRI envMap directly and rendered the
          drei sunset preset's marina imagery as literal background
          through the panel. meshPhysicalMaterial with clearcoat gives
          us the wet-glossy feel without refracting the environment. */}
      <mesh>
        <boxGeometry args={[width, height, depth]} />
        <meshPhysicalMaterial
          color={tint}
          transparent
          opacity={0.14}
          roughness={0.2}
          metalness={0.0}
          clearcoat={0.9}
          clearcoatRoughness={0.1}
          envMapIntensity={0.3}
          reflectivity={0.35}
        />
      </mesh>

      {/* Main text on the front face. When kineticType is on, each
          character drops from above + overshoots + settles with its
          own staggered delay — otherwise the whole string shows
          as a single Text element (original behavior). */}
      {text && !kineticType && (
        <Text
          position={[0, subtitle ? textY : 0, depth / 2 + 0.02]}
          fontSize={textSize}
          color={textColor}
          anchorX="center"
          anchorY="middle"
          fontWeight={800}
          maxWidth={width * 0.92}
          textAlign="center"
          letterSpacing={-0.01}
        >
          {text}
        </Text>
      )}
      {text && kineticType && (
        <KineticTitle
          text={text}
          position={[0, subtitle ? textY : 0, depth / 2 + 0.02]}
          fontSize={textSize}
          color={textColor}
          frame={frame}
          fps={fps}
          delayFrames={kineticDelayFrames}
          staggerFrames={kineticStaggerFrames}
          maxWidth={width * 0.92}
        />
      )}

      {/* Subtitle with its own inset backing band — sits in the lower
          25% of the panel so it never overlaps with wrapped main text. */}
      {subtitle && (
        <>
          <mesh position={[0, subtitleY, depth / 2 + 0.005]}>
            <planeGeometry args={[width * 0.88, subtitleSize * 2.4]} />
            <meshBasicMaterial color="#fffaf0" transparent opacity={0.82} />
          </mesh>
          <Text
            position={[0, subtitleY, depth / 2 + 0.015]}
            fontSize={subtitleSize}
            color={subtitleColor}
            anchorX="center"
            anchorY="middle"
            fontWeight={600}
            maxWidth={width * 0.82}
            textAlign="center"
          >
            {subtitle}
          </Text>
        </>
      )}
    </group>
  );
};

/**
 * Kinetic title — renders each character of `text` as its own drei Text
 * element and animates each one with a staggered drop-from-above spring
 * so the reveal feels physical, not synthetic.
 *
 * We lay out characters horizontally by estimating per-char width from
 * the fontSize (drei Text doesn't expose measured bounds before render).
 * For display-uppercase strings this approximation lands tight enough.
 */
// Advance LUT by character, as a fraction of fontSize. Tuned for drei's
// default SDF font at weight 800. Buckets balance setup cost vs. fidelity.
function charAdvanceFraction(ch: string): number {
  if (ch === " ") return 0.32;
  const u = ch.toUpperCase();
  // Very wide glyphs.
  if ("MWO".includes(u)) return 0.78;
  // Wide.
  if ("ABCDGHKNQRU&".includes(u)) return 0.68;
  // Medium.
  if ("EFLPSTVXYZ?!".includes(u)) return 0.6;
  // Narrow.
  if ("IJ1.,'-·".includes(u)) return 0.32;
  // Default for unknowns (digits, punctuation not listed).
  return 0.58;
}

const KineticTitle: React.FC<{
  text: string;
  position: [number, number, number];
  fontSize: number;
  color: string;
  frame: number;
  fps: number;
  delayFrames: number;
  staggerFrames: number;
  maxWidth: number;
}> = ({ text, position, fontSize, color, frame, fps, delayFrames, staggerFrames, maxWidth }) => {
  // Per-char advance LUT. A flat average cram wide letters (M, O, W) next
  // to narrow ones (I, T) — use buckets instead. Values are fractions of
  // fontSize based on the default drei SDF font metrics. Caller should
  // upper-case the string for best results (the LUT is uppercase-tuned).
  const chars = Array.from(text);
  const advances = chars.map((c) => fontSize * charAdvanceFraction(c));
  const totalWidth = advances.reduce((a, b) => a + b, 0);
  // If the natural layout would overflow maxWidth, scale everything down
  // uniformly so we don't clip. Keeps the reveal looking right regardless
  // of text length.
  const fitScale = totalWidth > maxWidth ? maxWidth / totalWidth : 1;
  const scaledFontSize = fontSize * fitScale;
  const scaledAdvances = advances.map((a) => a * fitScale);
  // Start x at left edge so characters flow right from there.
  const startX = position[0] - (totalWidth * fitScale) / 2;

  // Each character has its own spring progress keyed to its order.
  return (
    <group>
      {chars.map((ch, i) => {
        const charLocalX =
          startX +
          scaledAdvances.slice(0, i).reduce((a, b) => a + b, 0) +
          scaledAdvances[i] / 2;
        const revealFrame = delayFrames + i * staggerFrames;
        const progress = spring({
          frame: frame - revealFrame,
          fps,
          config: { damping: 12, mass: 0.6, stiffness: 140 },
        });
        // Drop from above: y starts +1 unit higher and eases to target.
        const dropY = interpolate(progress, [0, 1], [fontSize * 1.2, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const opacity = interpolate(progress, [0, 0.35, 1], [0, 0.6, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        });
        // Tiny per-character rotation jitter on arrival — deterministic so
        // each run of the same text looks identical across episodes.
        const seeded = (i * 9301 + 49297) % 233280;
        const jitterRad = ((seeded / 233280) - 0.5) * 0.12 * (1 - progress);
        if (opacity <= 0.01) return null;
        return (
          <Text
            key={`kc-${i}`}
            position={[charLocalX, position[1] + dropY, position[2]]}
            rotation={[0, 0, jitterRad]}
            fontSize={scaledFontSize}
            color={color}
            anchorX="center"
            anchorY="middle"
            fontWeight={800}
            fillOpacity={opacity}
            letterSpacing={-0.01}
          >
            {ch}
          </Text>
        );
      })}
    </group>
  );
};
