/**
 * r3f.count-up-bar — an extruded 3D bar that rises from 0 to `target`
 * with ASMR easing, chrome material, and a large number readout that
 * tracks the fill. Soft reflective floor catches the env highlights.
 *
 * Use for: "13% coding lift", "40 tokens/sec", "93-task benchmark".
 *
 * Layout: bar on left half of frame, big readout centered on right half.
 * This keeps both visible regardless of target value (no off-camera text
 * when the bar fills to max).
 *
 * Params:
 *   target:      number — the value the bar animates to (required)
 *   max?:        number — scale reference (bar height fills target/max ratio)
 *   label?:      string — subtitle below the readout ("coding lift")
 *   unit?:       string — appended to the number ("%", "B", "GB", "tok/s")
 *   color?:      string — hex for the bar (default warm chrome #f4eadb)
 *   formatDecimals?: number — 0 for ints, 1-2 for decimals (default 0)
 *   durationFrames?: number — count-up duration (default 60)
 *   barHeightMax?: number — max bar height in world units (default 1.8)
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
  barHeightMax?: number;
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
  barHeightMax = 1.8,
  motionProfile,
}) => {
  const frame = useCurrentFrame();
  const profile = getMotionProfile(motionProfile);

  const maxVal = max ?? target;
  const fillRatio = maxVal > 0 ? Math.min(1, target / maxVal) : 1;
  const finalHeight = barHeightMax * fillRatio;

  // Eased fill from frame 10 to frame (10 + durationFrames).
  const barHeight = interpolate(
    frame,
    [10, 10 + durationFrames],
    [0.01, finalHeight],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: asmrEasing },
  );

  // Number readout tracks the same curve.
  const displayValue = interpolate(
    frame,
    [10, 10 + durationFrames],
    [0, target],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: asmrEasing },
  );
  const numberText = formatDecimals > 0
    ? displayValue.toFixed(formatDecimals)
    : Math.round(displayValue).toString();

  // Breath-scale (ASMR only).
  const breath = profile.breathAmp > 0
    ? 1 + Math.sin((frame / profile.breathPeriodFrames) * Math.PI * 2) * profile.breathAmp * 0.3
    : 1;

  // Slow Y-axis wobble for the bar.
  const idleRotY = interpolate(frame, [0, 360], [-0.1, 0.1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "extend",
    easing: Easing.linear,
  });

  // Layout: bar on the LEFT, readout card on the RIGHT. Both anchored
  // to the horizontal center of the camera frame.
  const BAR_X = -2.0;
  const READOUT_X = 1.6;
  const FLOOR_Y = -1.0;

  return (
    <group scale={[breath, breath, breath]}>
      {/* Bar — grows from floor upward */}
      <mesh
        position={[BAR_X, FLOOR_Y + barHeight / 2, 0]}
        rotation={[0, idleRotY, 0]}
      >
        <boxGeometry args={[1.1, Math.max(0.02, barHeight), 1.1]} />
        <meshStandardMaterial
          {...chromeMaterialPreset}
          color={color}
        />
      </mesh>

      {/* Soft reflective floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y - 0.01, 0]}>
        <planeGeometry args={[12, 10]} />
        <meshStandardMaterial
          color="#0c1020"
          metalness={0.6}
          roughness={0.28}
          envMapIntensity={0.5}
        />
      </mesh>

      {/* Big number readout — FIXED position so it's visible at any target */}
      <Text
        position={[READOUT_X, 0.15, 0]}
        fontSize={1.4}
        anchorX="center"
        anchorY="middle"
        color={color}
        outlineWidth={0.025}
        outlineColor="#0a1629"
        outlineOpacity={0.9}
        fontWeight={800}
      >
        {numberText}{unit}
      </Text>

      {/* Label below the readout */}
      {label && (
        <Text
          position={[READOUT_X, -0.9, 0]}
          fontSize={0.28}
          anchorX="center"
          anchorY="middle"
          color="#c8d4e8"
          maxWidth={4.5}
          textAlign="center"
          letterSpacing={0.05}
        >
          {label.toUpperCase()}
        </Text>
      )}
    </group>
  );
};
