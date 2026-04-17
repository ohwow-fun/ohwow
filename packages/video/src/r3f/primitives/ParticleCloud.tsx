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

/**
 * Build a soft radial-gradient sprite on the fly. Each particle renders
 * as this sprite instead of a hard square pixel, so the cloud reads as
 * warm, glowing mist rather than a pixelated starfield.
 *
 * Cached in module scope so every scene shares one texture.
 */
let _softSpriteTexture: THREE.CanvasTexture | null = null;
function getSoftSprite(): THREE.CanvasTexture {
  if (_softSpriteTexture) return _softSpriteTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.65)");
    grad.addColorStop(0.7, "rgba(255,255,255,0.15)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  _softSpriteTexture = new THREE.CanvasTexture(canvas);
  _softSpriteTexture.needsUpdate = true;
  return _softSpriteTexture;
}

export const ParticleCloud: React.FC<ParticleCloudProps> = ({
  count = 400,
  spread = 6,
  color = "#f4eadb",
  // Much larger default — starfield dots were ~0.04 which renders as hard
  // pixels. Big, soft, sparse reads as warm ASMR mist, not a star map.
  size = 0.35,
  swirlSpeed = 0.08,
  seed = 1,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Generate deterministic particle positions once. We weight the radial
  // distribution so particles cluster gently toward the center with
  // softer density at the edges — feels less uniform/starfield-y.
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    const rand = seededRandom(seed);
    for (let i = 0; i < count; i++) {
      // Gaussian-ish via pair-sum; gives density fall-off from center.
      const gx = ((rand() + rand() + rand()) / 3 - 0.5) * 2;
      const gy = ((rand() + rand() + rand()) / 3 - 0.5) * 2;
      const gz = ((rand() + rand() + rand()) / 3 - 0.5) * 2;
      arr[i * 3 + 0] = gx * spread;
      arr[i * 3 + 1] = gy * spread * 0.7;
      arr[i * 3 + 2] = gz * spread;
    }
    return arr;
  }, [count, spread, seed]);

  const geometryRef = useRef<THREE.BufferGeometry>(null);
  const groupRef = useRef<THREE.Group>(null);

  // Slow swirl around Y axis — deterministic per-frame.
  const t = frame / fps;
  const rotY = t * swirlSpeed;

  const sprite = useMemo(() => getSoftSprite(), []);

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
          map={sprite}
        />
      </points>
    </group>
  );
};
