/**
 * r3f.number-sculpture — a large 3D numeral with chrome / iridescent
 * material, gently rotating. Use as a hero visual for a big headline
 * number ("35B", "13%", "1M").
 *
 * Uses drei Text with an extruded SDF approach. A real Text3D (geometry)
 * would be prettier but requires a font JSON; SDF Text keeps this
 * primitive self-contained.
 *
 * Params:
 *   value:     string | number — the numeral to display (e.g. "35B", "13%")
 *   color?:    string — hex (default warm chrome #f4eadb)
 *   label?:    string — subtitle under the numeral ("parameters", "lift")
 *   tiltSpeed?: number — radians/sec idle rotation (default 0.15)
 *   fontSize?: number — world-units text size (default 3.5)
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Text } from "@react-three/drei";
import { getMotionProfile } from "../../motion/asmr";

interface NumberSculptureProps {
  value?: string | number;
  color?: string;
  label?: string;
  tiltSpeed?: number;
  fontSize?: number;
  motionProfile?: string;
}

export const NumberSculpture: React.FC<NumberSculptureProps> = ({
  value = "0",
  color = "#f4eadb",
  label,
  tiltSpeed = 0.15,
  fontSize = 3.5,
  motionProfile,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const profile = getMotionProfile(motionProfile);

  // Slow Y rotation + subtle X wobble.
  const t = frame / fps;
  const rotY = Math.sin(t * tiltSpeed) * 0.25;
  const rotX = Math.sin(t * tiltSpeed * 0.6 + 1.2) * 0.08;

  // Breath-scale (ASMR only).
  const breath = profile.breathAmp > 0
    ? 1 + Math.sin((frame / profile.breathPeriodFrames) * Math.PI * 2) * profile.breathAmp * 0.3
    : 1;

  return (
    <group rotation={[rotX, rotY, 0]} scale={[breath, breath, breath]}>
      <Text
        fontSize={fontSize}
        color={color}
        anchorX="center"
        anchorY="middle"
        fontWeight={900}
        outlineWidth={0.035}
        outlineColor="#0a1629"
        outlineOpacity={0.85}
      >
        {String(value)}
      </Text>

      {label && (
        <Text
          position={[0, -fontSize * 0.6, 0]}
          fontSize={fontSize * 0.2}
          color="#c8d4e8"
          anchorX="center"
          anchorY="middle"
          maxWidth={fontSize * 3}
          textAlign="center"
        >
          {label}
        </Text>
      )}
    </group>
  );
};
