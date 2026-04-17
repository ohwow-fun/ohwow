/**
 * r3f.count-up-bar — an extruded 3D bar that rises from 0 to `target`
 * with ASMR easing, chrome material, slow idle rotation. A large number
 * readout above the bar counts up in sync.
 *
 * Use for: "13% coding lift", "40 tokens/sec", "93-task benchmark".
 *
 * Params:
 *   target:      number — the value the bar animates to (required)
 *   max?:        number — scale reference (bar height fills to target/max ratio)
 *   label?:      string — subtitle below the number ("coding lift", "GGUF size")
 *   unit?:       string — appended to the number ("%", "B", "GB", "tok/s")
 *   color?:      string — hex for the bar (default warm chrome #f4eadb)
 *   formatDecimals?: number — 0 for ints, 1–2 for decimals (default 0)
 *   durationFrames?: number — how long the count-up takes (default 60)
 */
import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import { Text } from "@react-three/drei";
import { asmrEasing, chromeMaterialPreset, getMotionProfile } from "../../motion/asmr";

interface CountUpBarProps {
  target?: number;
  max?: number;
  label?: string;
  unit?: string;
  color?: string;
  formatDecimals?: number;
  durationFrames?: number;
  motionProfile?: string;
}

export const CountUpBar: React.FC<CountUpBarProps> = ({
  target = 100,
  max,
  label,
  unit = "",
  color = "#f4eadb",
  formatDecimals = 0,
  durationFrames = 60,
  motionProfile,
}) => {
  const frame = useCurrentFrame();
  const profile = getMotionProfile(motionProfile);

  // Bar height is normalized: fills from 0 to (target/max) * 3 units.
  // If max is unset, treat target as 100% of the bar.
  const maxVal = max ?? target;
  const fillRatio = maxVal > 0 ? Math.min(1, target / maxVal) : 1;
  const finalHeight = 3 * fillRatio;

  // Eased fill from frame 10 to frame (10 + durationFrames).
  const barHeight = interpolate(
    frame,
    [10, 10 + durationFrames],
    [0.01, finalHeight],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: asmrEasing },
  );

  // Number readout counts the same curve — by explicitly using the
  // same interp we keep the digits pinned to the bar's growth.
  const displayValue = interpolate(
    frame,
    [10, 10 + durationFrames],
    [0, target],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: asmrEasing },
  );
  const numberText = formatDecimals > 0
    ? displayValue.toFixed(formatDecimals)
    : Math.round(displayValue).toString();

  // Breath-scale on the whole group (ASMR-only, disabled for crisp/chaotic).
  const breath = profile.breathAmp > 0
    ? 1 + Math.sin((frame / profile.breathPeriodFrames) * Math.PI * 2) * profile.breathAmp * 0.5
    : 1;

  // Slow idle rotation for the bar, ASMR-like.
  const idleRotY = interpolate(frame, [0, 360], [-0.12, 0.12], {
    extrapolateLeft: "clamp",
    extrapolateRight: "extend",
    easing: Easing.linear,
  });

  return (
    <group scale={[breath, breath, breath]}>
      {/* The bar: box geometry, chrome material, pinned to y=barHeight/2 so it grows from the floor up */}
      <mesh
        position={[0, barHeight / 2 - 0.5, 0]}
        rotation={[0, idleRotY, 0]}
      >
        <boxGeometry args={[1.2, Math.max(0.02, barHeight), 1.2]} />
        <meshStandardMaterial
          {...chromeMaterialPreset}
          color={color}
        />
      </mesh>

      {/* Soft reflective floor (a wide, semi-transparent plane) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.51, 0]}>
        <planeGeometry args={[8, 8]} />
        <meshStandardMaterial
          color="#0c0c14"
          metalness={0.5}
          roughness={0.35}
          transparent
          opacity={0.9}
        />
      </mesh>

      {/* Number + unit readout above the bar */}
      <Text
        position={[0, finalHeight + 0.9, 0]}
        fontSize={1.1}
        anchorX="center"
        anchorY="middle"
        color="#ffffff"
        outlineWidth={0.02}
        outlineColor="#0a1629"
      >
        {numberText}{unit}
      </Text>

      {/* Optional label line */}
      {label && (
        <Text
          position={[0, finalHeight + 0.15, 0]}
          fontSize={0.28}
          anchorX="center"
          anchorY="middle"
          color="#c8d4e8"
          maxWidth={6}
          textAlign="center"
        >
          {label}
        </Text>
      )}
    </group>
  );
};
