/**
 * r3f.logo-reveal — the ohwow brand ritual. The iridescent ring drops
 * in with a bouncy spring entrance, holds with a slow breath + gentle
 * rotation, and releases at the end.
 *
 * Designed for the first ~60 frames of a Briefing intro (cold open).
 * Clean composition — nothing besides the ring and pure black. No
 * particles, no warm glow disc, no ember flare. The iridescent ring
 * is the hero; anything else distracts.
 *
 * Choreography (0→durationInFrames):
 *   0-55%   Bounce in  — scale 0 → overshoot → settle with spring; rotation unwinds
 *   55-85%  Hold       — slow rotation + subtle breath scale
 *   85-100% Release    — scale grows slightly + opacity fades out
 *
 * Params:
 *   logoUrl?:     string — public URL to the ring PNG (default: ohwow-logo.png)
 *   size?:        number — final ring diameter in world units (default 3.0)
 *   durationInFrames?: number — scene length (default 90)
 *   bounce?:      number — spring damping (lower = bouncier; default 10)
 */
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring, Easing, staticFile } from "remotion";
import { Billboard } from "@react-three/drei";
import * as THREE from "three";

interface LogoRevealProps {
  logoUrl?: string;
  size?: number;
  durationInFrames?: number;
  bounce?: number;
  motionProfile?: string;
  // Legacy params kept for back-compat; no longer used.
  particleCount?: number;
  emberColor?: string;
  glowColor?: string;
}

const LOGO_PATH = "ohwow-logo.png";

export const LogoReveal: React.FC<LogoRevealProps> = ({
  logoUrl,
  size = 3.0,
  durationInFrames = 90,
  bounce = 10,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = Math.max(0, Math.min(1, frame / durationInFrames));
  const resolvedLogoUrl = useMemo(
    () => logoUrl ?? staticFile(LOGO_PATH),
    [logoUrl],
  );

  const HOLD_END = 0.85;

  // Bouncy spring entrance: scale 0 → overshoots 1.0 → settles. Lower
  // damping = more bounce. The spring settles around ~35 frames at
  // 30fps with these defaults, leaving the rest of the scene for hold.
  const entrance = spring({
    frame,
    fps,
    config: { damping: bounce, mass: 0.9, stiffness: 130 },
  });

  // Rotation: starts pre-rotated and unwinds as the spring settles.
  // Gives the ring a satisfying "landed" feel — rotation resolves
  // simultaneously with scale.
  const entranceRot = interpolate(entrance, [0, 1], [-Math.PI * 0.6, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Subtle breath during hold (post-entrance).
  const holdT = Math.max(0, Math.min(1, (t - 0.35) / (HOLD_END - 0.35)));
  const breath = 1 + Math.sin(holdT * Math.PI * 1.4) * 0.025;

  // Release — scale grows gently, opacity fades at the very end so
  // the next scene can take over cleanly.
  const releaseScale = interpolate(
    t,
    [HOLD_END, 1.0],
    [1.0, 1.12],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) },
  );
  const releaseOpacity = interpolate(
    t,
    [HOLD_END, 1.0],
    [1.0, 0.0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) },
  );

  // Continuous slow rotation throughout the hold — adds life without
  // being distracting.
  const idleRot = t * Math.PI * 0.25;

  const ringScale = entrance * breath * releaseScale * size;
  const ringRotation = entranceRot + idleRot;
  // Fade-in opacity tracks the spring so the ring doesn't pop in if it
  // overshoots below 0 before the spring settles.
  const ringOpacity = Math.min(releaseOpacity, interpolate(entrance, [0, 0.3], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));

  const logoTexture = useMemo(() => {
    const loader = new THREE.TextureLoader();
    const tex = loader.load(resolvedLogoUrl);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [resolvedLogoUrl]);

  if (ringOpacity <= 0.01) return null;

  return (
    <Billboard>
      <mesh scale={[ringScale, ringScale, 1]} rotation={[0, 0, ringRotation]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={logoTexture}
          transparent
          opacity={ringOpacity}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </Billboard>
  );
};
