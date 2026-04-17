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
  const bandHeight = height * 0.88;
  const textY = height * 0.18;
  const subtitleY = -height * 0.32;

  return (
    <group position={[position[0], position[1] + yFloat, position[2]]} rotation={rotation}>
      {/* Frosted contrast band BEHIND the glass — sits just behind the
          glass front face, gives the text something solid to read
          against instead of HDRI transmission. Nearly opaque so the
          env map's marina/studio imagery doesn't bleed through onto
          the caption area. */}
      <mesh position={[0, 0, -depth * 0.25]}>
        <planeGeometry args={[width * 0.96, bandHeight]} />
        <meshStandardMaterial
          color={tint}
          roughness={0.5}
          metalness={0.1}
          transparent
          opacity={0.97}
        />
      </mesh>

      {/* The glass slab itself. transmission dialed DOWN (0.7 → 0.38)
          so we still get the caustic-y glass character for edges but
          the HDRI imagery doesn't render as a literal background
          photo through the center. */}
      <mesh>
        <boxGeometry args={[width, height, depth]} />
        <MeshTransmissionMaterial
          backside
          samples={4}
          resolution={256}
          transmission={0.38}
          roughness={0.18}
          thickness={0.5}
          ior={1.45}
          chromaticAberration={0.015}
          anisotropy={0.08}
          distortion={0.08}
          distortionScale={0.3}
          temporalDistortion={0.01}
          clearcoat={0.85}
          attenuationDistance={0.8}
          attenuationColor={tint}
          color={tint}
        />
      </mesh>

      {/* Main text on the front face */}
      {text && (
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
