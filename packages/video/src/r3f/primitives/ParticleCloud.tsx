/**
 * r3f.particle-cloud — a slowly-swirling 3D particle field with depth
 * fog and warm-palette colors. Serves as ASMR backdrop texture behind
 * other primitives or on its own during transition moments.
 *
 * Uses Three's Points for performance — no geometry-per-particle.
 *
 * Params:
 *   count?:        number — particle count (default 800)
 *   spread?:       number — cube volume half-width (default 6)
 *   color?:        string — base particle color (default warm cream #f4eadb)
 *   size?:         number — point size in world units (default 0.04)
 *   swirlSpeed?:   number — radians/sec around Y axis (default 0.08)
 *   seed?:         number — RNG seed for deterministic positions (default 1)
 */
import React, { useMemo, useRef } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";

interface ParticleCloudProps {
  count?: number;
  spread?: number;
  color?: string;
  size?: number;
  swirlSpeed?: number;
  seed?: number;
  motionProfile?: string;
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export const ParticleCloud: React.FC<ParticleCloudProps> = ({
  count = 800,
  spread = 6,
  color = "#f4eadb",
  size = 0.04,
  swirlSpeed = 0.08,
  seed = 1,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Generate deterministic particle positions once.
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    const rand = seededRandom(seed);
    for (let i = 0; i < count; i++) {
      // Uniform distribution in a cube; slightly biased toward the camera
      // via a z-bias so foreground particles read larger.
      arr[i * 3 + 0] = (rand() * 2 - 1) * spread;
      arr[i * 3 + 1] = (rand() * 2 - 1) * spread * 0.7;
      arr[i * 3 + 2] = (rand() * 2 - 1) * spread;
    }
    return arr;
  }, [count, spread, seed]);

  const geometryRef = useRef<THREE.BufferGeometry>(null);
  const groupRef = useRef<THREE.Group>(null);

  // Slow swirl around Y axis — deterministic per-frame.
  const t = frame / fps;
  const rotY = t * swirlSpeed;

  return (
    <group ref={groupRef} rotation={[0, rotY, 0]}>
      <points>
        <bufferGeometry ref={geometryRef}>
          <bufferAttribute
            attach="attributes-position"
            args={[positions, 3]}
            count={count}
            array={positions}
            itemSize={3}
          />
        </bufferGeometry>
        <pointsMaterial
          color={color}
          size={size}
          sizeAttenuation
          transparent
          opacity={0.85}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
};
