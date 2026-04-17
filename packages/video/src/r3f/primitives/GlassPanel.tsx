/**
 * r3f.glass-panel — a frosted glass slab that refracts the scene
 * behind it. Acts as a floating container for caption text or model
 * metadata. The refraction + subtle caustic feel is the ASMR money shot.
 *
 * Params:
 *   width?:    number (default 4.5)
 *   height?:   number (default 2.6)
 *   depth?:    number (default 0.12)
 *   position?: [x, y, z] (default [0, 0, 0])
 *   rotation?: [rx, ry, rz] radians (default [0, 0, 0])
 *   tint?:     string — subtle color tint for the glass (default #d8e8ff)
 *   text?:     string — optional large text overlaid on the front face
 *   textColor?: string (default #0a1629)
 *   subtitle?: string
 *   idleFloat?: boolean — gentle Y oscillation (default true)
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Text, MeshTransmissionMaterial } from "@react-three/drei";
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
}

export const GlassPanel: React.FC<GlassPanelProps> = ({
  width = 4.5,
  height = 2.6,
  depth = 0.12,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  tint = "#d8e8ff",
  text,
  textColor = "#0a1629",
  subtitle,
  subtitleColor = "#2a3a55",
  idleFloat = true,
  motionProfile,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const profile = getMotionProfile(motionProfile);

  // Gentle float on Y for ASMR presence.
  const t = frame / fps;
  const yFloat = idleFloat && profile.breathAmp > 0
    ? Math.sin(t * 0.5) * 0.08
    : 0;

  return (
    <group position={[position[0], position[1] + yFloat, position[2]]} rotation={rotation}>
      <mesh>
        <boxGeometry args={[width, height, depth]} />
        <MeshTransmissionMaterial
          backside
          samples={4}
          resolution={256}
          transmission={0.95}
          roughness={0.06}
          thickness={0.35}
          ior={1.5}
          chromaticAberration={0.02}
          anisotropy={0.1}
          distortion={0.12}
          distortionScale={0.3}
          temporalDistortion={0.02}
          clearcoat={0.7}
          attenuationDistance={1.2}
          attenuationColor={tint}
          color={tint}
        />
      </mesh>

      {text && (
        <Text
          position={[0, subtitle ? height * 0.12 : 0, depth / 2 + 0.01]}
          fontSize={height * 0.32}
          color={textColor}
          anchorX="center"
          anchorY="middle"
          fontWeight={800}
          maxWidth={width * 0.85}
          textAlign="center"
        >
          {text}
        </Text>
      )}

      {subtitle && (
        <Text
          position={[0, -height * 0.18, depth / 2 + 0.01]}
          fontSize={height * 0.11}
          color={subtitleColor}
          anchorX="center"
          anchorY="middle"
          fontWeight={500}
          maxWidth={width * 0.85}
          textAlign="center"
        >
          {subtitle}
        </Text>
      )}
    </group>
  );
};
