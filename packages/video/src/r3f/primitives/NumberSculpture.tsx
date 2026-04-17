/**
 * r3f.number-sculpture — a large extruded 3D numeral with chrome
 * material, gently rotating. True 3D geometry (Text3D) rather than
 * flat SDF text, so the numeral catches environment highlights.
 *
 * Use as a hero visual for a big headline number ("35B", "13%", "1M").
 *
 * Params:
 *   value:     string | number — the numeral to display (e.g. "35B", "13%")
 *   color?:    string — hex (default warm chrome #f4eadb)
 *   label?:    string — caption above the numeral ("parameters", "lift")
 *   tiltSpeed?: number — radians/sec idle rotation (default 0.15)
 *   size?:     number — world-units geometry height (default 1.6)
 *   depth?:    number — extrusion depth (default 0.35)
 *   fontUrl?:  string — drei-compatible JSON font URL
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Center, Text, Text3D } from "@react-three/drei";
import { chromeMaterialPreset, getMotionProfile } from "../../motion/asmr";

interface NumberSculptureProps {
  value?: string | number;
  color?: string;
  label?: string;
  tiltSpeed?: number;
  size?: number;
  depth?: number;
  /**
   * URL of a drei-compatible font JSON (typeface.json format). Defaults
   * to Helvetiker Bold from the three.js CDN — no local font file needed.
   */
  fontUrl?: string;
  motionProfile?: string;
}

const DEFAULT_FONT_URL =
  "https://threejs.org/examples/fonts/helvetiker_bold.typeface.json";

export const NumberSculpture: React.FC<NumberSculptureProps> = ({
  value = "0",
  color = "#f4eadb",
  label,
  tiltSpeed = 0.15,
  size = 1.6,
  depth = 0.35,
  fontUrl = DEFAULT_FONT_URL,
  motionProfile,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const profile = getMotionProfile(motionProfile);

  // Slow Y rotation + subtle X wobble.
  const t = frame / fps;
  const rotY = Math.sin(t * tiltSpeed) * 0.35;
  const rotX = Math.sin(t * tiltSpeed * 0.6 + 1.2) * 0.08;

  // Breath-scale (ASMR only).
  const breath = profile.breathAmp > 0
    ? 1 + Math.sin((frame / profile.breathPeriodFrames) * Math.PI * 2) * profile.breathAmp * 0.25
    : 1;

  return (
    <group rotation={[rotX, rotY, 0]} scale={[breath, breath, breath]}>
      {/* Label positioned ABOVE the numeral so it doesn't collide with
          the voice-caption overlay which lives at the bottom of the
          frame. Uses SDF Text since the label is small and doesn't need
          extrusion. */}
      {label && (
        <Text
          position={[0, size * 1.2, 0]}
          fontSize={size * 0.2}
          color="#c8d4e8"
          anchorX="center"
          anchorY="middle"
          maxWidth={size * 6}
          textAlign="center"
          letterSpacing={0.04}
        >
          {label.toUpperCase()}
        </Text>
      )}

      {/* The numeral itself — real 3D geometry with chrome material.
          Center auto-aligns Text3D to (0,0,0) of the local frame. */}
      <Center>
        <Text3D
          font={fontUrl}
          size={size}
          height={depth}
          curveSegments={8}
          bevelEnabled
          bevelSize={size * 0.015}
          bevelThickness={size * 0.02}
          bevelSegments={3}
        >
          {String(value)}
          <meshStandardMaterial
            {...chromeMaterialPreset}
            color={color}
          />
        </Text3D>
      </Center>
    </group>
  );
};
