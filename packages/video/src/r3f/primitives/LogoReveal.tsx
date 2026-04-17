/**
 * r3f.logo-reveal — the ohwow brand ritual. Warm particles converge
 * from off-frame to a point; the point blooms; the iridescent
 * ohwow ring materializes at the bloom; a held beat; a slow rotation.
 *
 * Designed for the first ~90 frames of a Briefing intro (cold open)
 * and the last ~30 frames of an outro (signature lock). Same motion
 * every episode so viewers subconsciously learn the ritual.
 *
 * Choreography (0→durationInFrames):
 *   0-30%   Converge  — particles spiral inward to center, white-hot point grows
 *   30-55%  Bloom     — point flares into a bright disk, then the iridescent
 *                       ring takes over
 *   55-85%  Hold      — ring rotates slowly, slight breath-scale
 *   85-100% Release   — ring fades as the next element takes focus
 *
 * Params:
 *   logoUrl?:     string — public URL to the ring PNG (default: ohwow-logo.png)
 *   size?:        number — final ring diameter in world units (default 3.0)
 *   emberColor?:  string — convergence point color (default warm white #fff5e0)
 *   particleCount?: number (default 140)
 *   glowColor?:   string — ambient bloom color (default warm #f4c893)
 */
import React, { useMemo } from "react";
import { useCurrentFrame, interpolate, Easing, staticFile } from "remotion";
import { Billboard } from "@react-three/drei";
import * as THREE from "three";

interface LogoRevealProps {
  logoUrl?: string;
  size?: number;
  emberColor?: string;
  particleCount?: number;
  glowColor?: string;
  durationInFrames?: number;
  motionProfile?: string;
}

// Soft radial sprite shared with ParticleCloud — cached at module scope.
let _softSprite: THREE.CanvasTexture | null = null;
function getSoftSprite(): THREE.CanvasTexture {
  if (_softSprite) return _softSprite;
  const s = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.4, "rgba(255,255,255,0.55)");
    grad.addColorStop(0.75, "rgba(255,255,255,0.12)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
  }
  _softSprite = new THREE.CanvasTexture(canvas);
  _softSprite.needsUpdate = true;
  return _softSprite;
}

const LOGO_PATH = "ohwow-logo.png";

export const LogoReveal: React.FC<LogoRevealProps> = ({
  logoUrl,
  size = 3.0,
  emberColor = "#fff5e0",
  particleCount = 140,
  glowColor = "#f4c893",
  durationInFrames = 90,
}) => {
  const frame = useCurrentFrame();
  const t = Math.max(0, Math.min(1, frame / durationInFrames));
  const resolvedLogoUrl = useMemo(
    () => logoUrl ?? staticFile(LOGO_PATH),
    [logoUrl],
  );

  // Phase boundaries (normalized).
  const CONVERGE_END = 0.30;
  const BLOOM_END = 0.55;
  const HOLD_END = 0.85;

  // Particle positions — each particle has a deterministic start position
  // far from center and converges toward (0,0,0) over the Converge phase.
  const particleSeeds = useMemo(() => {
    const seeds: Array<{ startX: number; startY: number; startZ: number; phase: number; speed: number }> = [];
    // Tiny seeded RNG.
    let s = 7 >>> 0;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
    for (let i = 0; i < particleCount; i++) {
      const theta = rand() * Math.PI * 2;
      const phi = (rand() - 0.5) * Math.PI * 0.7;
      const radius = 4.5 + rand() * 3.0;
      seeds.push({
        startX: Math.cos(theta) * Math.cos(phi) * radius,
        startY: Math.sin(phi) * radius,
        startZ: Math.sin(theta) * Math.cos(phi) * radius,
        phase: rand(),
        speed: 0.7 + rand() * 0.6,
      });
    }
    return seeds;
  }, [particleCount]);

  // Particle opacity + position during Converge + Bloom; fades during Hold.
  const particlePositions = useMemo(() => {
    const arr = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const seed = particleSeeds[i];
      // Each particle starts moving at its own phase offset so they don't
      // all arrive at once — staggered convergence.
      const rawProgress = (t - seed.phase * 0.15) * seed.speed;
      const progress = Math.max(0, Math.min(1, rawProgress / CONVERGE_END));
      // Eased inward curve with slight overshoot for that "gathering" pull.
      const eased = Easing.inOut(Easing.cubic)(progress);
      const px = seed.startX * (1 - eased);
      const py = seed.startY * (1 - eased);
      const pz = seed.startZ * (1 - eased);
      arr[i * 3 + 0] = px;
      arr[i * 3 + 1] = py;
      arr[i * 3 + 2] = pz;
    }
    return arr;
  }, [t, particleCount, particleSeeds]);

  // Convergence point/flare grows during Converge, flares at Bloom start,
  // then fades as the ring takes over.
  const emberScale = interpolate(
    t,
    [0, CONVERGE_END, BLOOM_END, HOLD_END],
    [0.01, 0.9, 2.4, 0.0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) },
  );
  const emberOpacity = interpolate(
    t,
    [0, CONVERGE_END, BLOOM_END, HOLD_END],
    [0.0, 0.9, 0.85, 0.0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const particleOpacity = interpolate(
    t,
    [0, CONVERGE_END * 0.6, CONVERGE_END, BLOOM_END],
    [0.0, 0.85, 0.7, 0.0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Logo ring — scales from 0 at Bloom start, overshoots slightly, settles.
  const ringProgress = Math.max(0, Math.min(1, (t - CONVERGE_END) / (BLOOM_END - CONVERGE_END)));
  const ringScaleBase = interpolate(
    ringProgress,
    [0, 0.6, 1.0],
    [0.05, 1.15, 1.0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) },
  );
  // Subtle breath during hold phase.
  const holdProgress = Math.max(0, Math.min(1, (t - BLOOM_END) / (HOLD_END - BLOOM_END)));
  const breath = 1 + Math.sin(holdProgress * Math.PI * 1.2) * 0.03;
  const releaseScale = interpolate(
    t,
    [HOLD_END, 1.0],
    [1.0, 1.18],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) },
  );
  const ringScale = ringScaleBase * breath * releaseScale * size;
  const ringOpacity = interpolate(
    t,
    [CONVERGE_END * 0.95, BLOOM_END * 0.7, HOLD_END, 1.0],
    [0.0, 1.0, 1.0, 0.0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const ringRotation = t * Math.PI * 0.4; // slow rotate across the full duration

  // Ambient warm glow disc that sits BEHIND the ring — catches the eye
  // during Bloom, fades during release.
  const glowScale = interpolate(
    t,
    [CONVERGE_END, BLOOM_END, HOLD_END, 1.0],
    [0.5, 3.5, 2.8, 4.5],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) },
  );
  const glowOpacity = interpolate(
    t,
    [CONVERGE_END, BLOOM_END, HOLD_END, 1.0],
    [0.0, 0.55, 0.3, 0.0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const sprite = useMemo(() => getSoftSprite(), []);
  const logoTexture = useMemo(() => {
    const loader = new THREE.TextureLoader();
    const tex = loader.load(resolvedLogoUrl);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [resolvedLogoUrl]);

  return (
    <group>
      {/* Ambient warm glow — additive disc behind everything */}
      <Billboard>
        <mesh scale={[glowScale, glowScale, 1]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            map={sprite}
            color={glowColor}
            transparent
            opacity={glowOpacity}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </Billboard>

      {/* Converging particles — dissolve once ember blooms */}
      {particleOpacity > 0.01 && (
        <points>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[particlePositions, 3]}
              count={particleCount}
              array={particlePositions}
              itemSize={3}
            />
          </bufferGeometry>
          <pointsMaterial
            color={glowColor}
            size={0.32}
            sizeAttenuation
            transparent
            opacity={particleOpacity}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            map={sprite}
          />
        </points>
      )}

      {/* Ember flare — the moment of ignition */}
      {emberOpacity > 0.01 && (
        <Billboard>
          <mesh scale={[emberScale, emberScale, 1]}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial
              map={sprite}
              color={emberColor}
              transparent
              opacity={emberOpacity}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        </Billboard>
      )}

      {/* The iridescent ohwow ring — the brand mark */}
      {ringOpacity > 0.01 && (
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
      )}
    </group>
  );
};
