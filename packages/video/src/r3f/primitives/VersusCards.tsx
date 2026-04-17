/**
 * r3f.versus-cards — two floating 3D cards (before/after, old/new) with
 * a central divider light. Left card dims/fades; right card brightens/
 * glows as the scene progresses. ASMR-slow crossfade.
 *
 * Use for: "Opus 4.6 → 4.7", "old API → new API", "competitor → us".
 *
 * Params:
 *   before:      { label: string, value?: string }
 *   after:       { label: string, value?: string }
 *   label?:      string — optional metric label above both cards ("coding benchmark")
 *   transitionAt?: number — frame where the fade starts (default 30)
 *   transitionDuration?: number — frames for the fade (default 60)
 */
import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { Text } from "@react-three/drei";
import { asmrEasing, chromeMaterialPreset, getMotionProfile } from "../../motion/asmr";

interface Card {
  label: string;
  value?: string;
}

interface VersusCardsProps {
  before?: Card;
  after?: Card;
  label?: string;
  transitionAt?: number;
  transitionDuration?: number;
  motionProfile?: string;
}

const CardMesh: React.FC<{
  position: [number, number, number];
  tint: string;
  brightness: number;
  label: string;
  value?: string;
  accentColor: string;
}> = ({ position, tint, brightness, label, value, accentColor }) => {
  return (
    <group position={position}>
      {/* Card body — tall rounded box */}
      <mesh>
        <boxGeometry args={[2.4, 3.2, 0.15]} />
        <meshStandardMaterial
          {...chromeMaterialPreset}
          color={tint}
          emissive={accentColor}
          emissiveIntensity={brightness * 0.3}
        />
      </mesh>

      {/* Value — large text centered on the card */}
      {value && (
        <Text
          position={[0, 0.3, 0.08]}
          fontSize={0.8}
          color="#ffffff"
          anchorX="center"
          anchorY="middle"
          fontWeight={800}
          outlineWidth={0.015}
          outlineColor="#0a1629"
        >
          {value}
        </Text>
      )}

      {/* Label — smaller text below */}
      <Text
        position={[0, value ? -0.6 : 0, 0.08]}
        fontSize={0.3}
        color="#c8d4e8"
        anchorX="center"
        anchorY="middle"
        maxWidth={2.1}
        textAlign="center"
      >
        {label}
      </Text>
    </group>
  );
};

export const VersusCards: React.FC<VersusCardsProps> = ({
  before = { label: "Before" },
  after = { label: "After" },
  label,
  transitionAt = 30,
  transitionDuration = 60,
  motionProfile,
}) => {
  const frame = useCurrentFrame();
  const profile = getMotionProfile(motionProfile);

  // Brightness crossfade: before starts at 1, drops to 0.45; after starts at 0.45, rises to 1.
  const afterBrightness = interpolate(
    frame,
    [transitionAt, transitionAt + transitionDuration],
    [0.4, 1.0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: asmrEasing },
  );
  const beforeBrightness = interpolate(
    frame,
    [transitionAt, transitionAt + transitionDuration],
    [1.0, 0.35],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: asmrEasing },
  );

  // Breath scale when ASMR profile is on.
  const breath = profile.breathAmp > 0
    ? 1 + Math.sin((frame / profile.breathPeriodFrames) * Math.PI * 2) * profile.breathAmp * 0.4
    : 1;

  return (
    <group scale={[breath, breath, breath]}>
      {/* Optional metric label above both cards */}
      {label && (
        <Text
          position={[0, 2.4, 0]}
          fontSize={0.42}
          color="#e3b58a"
          anchorX="center"
          anchorY="middle"
        >
          {label}
        </Text>
      )}

      {/* Left card: before */}
      <CardMesh
        position={[-1.85, 0, 0]}
        tint="#2a333f"
        brightness={beforeBrightness}
        label={before.label}
        value={before.value}
        accentColor="#5e6d82"
      />

      {/* Central divider: a thin luminous bar */}
      <mesh position={[0, 0, 0.1]}>
        <boxGeometry args={[0.05, 3.4, 0.05]} />
        <meshStandardMaterial
          color="#e3b58a"
          emissive="#e3b58a"
          emissiveIntensity={0.8}
        />
      </mesh>

      {/* Right card: after */}
      <CardMesh
        position={[1.85, 0, 0]}
        tint="#f4eadb"
        brightness={afterBrightness}
        label={after.label}
        value={after.value}
        accentColor="#f0c89b"
      />
    </group>
  );
};
