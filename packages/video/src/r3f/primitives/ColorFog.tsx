/**
 * r3f.color-fog — a cluster of large soft-edged colored orbs at varying
 * depths that drift and pulse slowly. Reads as a dark, atmospheric,
 * "bokeh nebula" backdrop — colorful but dark enough that white
 * foreground text sits cleanly on top.
 *
 * Each orb is a billboarded plane with a radial-gradient sprite, alpha
 * blended (not additive) so stacked orbs stay dark where they overlap
 * the black background. Low opacity per orb keeps the scene dim.
 *
 * Params:
 *   orbs?:      Array<{ color: string, x?, y?, z?, radius? }>
 *   drift?:     number — amplitude of slow wander (default 0.35)
 *   driftSpeed?: number — cycles/sec (default 0.08)
 *   opacity?:   number — per-orb alpha (default 0.35)
 */
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Billboard } from "@react-three/drei";
import * as THREE from "three";

interface OrbSpec {
  color: string;
  x?: number;
  y?: number;
  z?: number;
  radius?: number;
}

interface ColorFogProps {
  orbs?: OrbSpec[];
  drift?: number;
  driftSpeed?: number;
  opacity?: number;
  motionProfile?: string;
}

// Soft radial gradient sprite shared across primitives.
let _softSprite: THREE.CanvasTexture | null = null;
function getSoftSprite(): THREE.CanvasTexture {
  if (_softSprite) return _softSprite;
  const s = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.3, "rgba(255,255,255,0.7)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.3)");
    grad.addColorStop(0.85, "rgba(255,255,255,0.08)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
  }
  _softSprite = new THREE.CanvasTexture(canvas);
  _softSprite.needsUpdate = true;
  return _softSprite;
}

// A balanced default palette: warm amber, cool teal, electric violet,
// deep magenta, icy blue. All darkened via opacity to keep backdrop dark.
const DEFAULT_ORBS: OrbSpec[] = [
  { color: "#e3b58a", x: -4.2, y: 1.5, z: -2, radius: 4.2 },
  { color: "#6b9fd4", x: 3.8, y: -1.2, z: -1.5, radius: 4.8 },
  { color: "#b472c9", x: -2.5, y: -2.0, z: -3, radius: 3.5 },
  { color: "#d86a8a", x: 4.5, y: 2.2, z: -2.5, radius: 3.8 },
  { color: "#5fb8c6", x: 0, y: 0.3, z: -4, radius: 5.0 },
];

export const ColorFog: React.FC<ColorFogProps> = ({
  orbs = DEFAULT_ORBS,
  drift = 0.35,
  driftSpeed = 0.08,
  opacity = 0.4,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const sprite = useMemo(() => getSoftSprite(), []);

  return (
    <group>
      {orbs.map((o, i) => {
        // Each orb has its own phase so they don't pulse in sync.
        const phaseX = i * 1.3;
        const phaseY = i * 0.7 + 0.5;
        const phaseA = i * 0.9;
        const dx = Math.sin(t * driftSpeed * Math.PI * 2 + phaseX) * drift;
        const dy = Math.cos(t * driftSpeed * Math.PI * 2 + phaseY) * drift * 0.6;
        // Breath opacity — each orb pulses slightly.
        const pulse = 0.88 + 0.12 * Math.sin(t * driftSpeed * Math.PI * 3 + phaseA);
        const radius = o.radius ?? 4.0;
        return (
          <Billboard
            key={`orb-${i}`}
            position={[(o.x ?? 0) + dx, (o.y ?? 0) + dy, o.z ?? -2]}
          >
            <mesh scale={[radius, radius, 1]}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial
                map={sprite}
                color={o.color}
                transparent
                opacity={opacity * pulse}
                depthWrite={false}
                blending={THREE.NormalBlending}
                toneMapped={false}
              />
            </mesh>
          </Billboard>
        );
      })}
    </group>
  );
};
