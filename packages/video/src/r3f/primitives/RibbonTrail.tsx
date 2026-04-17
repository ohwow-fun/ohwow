/**
 * r3f.ribbon-trail — a luminous ribbon tracing a curved bezier path
 * across the scene. Used as ASMR motion texture — a soft stream of
 * light that implies flow, connection, timeline.
 *
 * Built as a tube geometry along a CatmullRom curve. Material is
 * emissive + chrome so it catches the environment light.
 *
 * Params:
 *   path?:      Array<[x,y,z]> — control points of the curve (default: a gentle S-shape)
 *   thickness?: number — tube radius (default 0.04)
 *   color?:     string — emissive color (default warm gold #f0c89b)
 *   flowSpeed?: number — UV flow speed (default 0.3) — controls shimmer
 *   segments?:  number — tube longitudinal segments (default 120)
 */
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";

interface RibbonTrailProps {
  path?: Array<[number, number, number]>;
  thickness?: number;
  color?: string;
  flowSpeed?: number;
  segments?: number;
}

// Default path keeps the ribbon entirely BEHIND z=0 so it sits as a
// backdrop texture rather than crossing in front of foreground panels /
// sculptures. Scenes that want the ribbon to weave around a primitive
// can override `path` with their own z-range.
const DEFAULT_PATH: Array<[number, number, number]> = [
  [-5, -1.5, -2.5],
  [-2.5, 0.8, -1.2],
  [0, -0.4, -2.0],
  [2.5, 0.9, -1.2],
  [5, -0.8, -2.5],
];

export const RibbonTrail: React.FC<RibbonTrailProps> = ({
  path = DEFAULT_PATH,
  thickness = 0.06,
  color = "#f0c89b",
  flowSpeed = 0.3,
  segments = 120,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  // Build tube geometry once per path.
  const geometry = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(
      path.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      false,
      "centripetal",
      0.5,
    );
    return new THREE.TubeGeometry(curve, segments, thickness, 12, false);
  }, [path, segments, thickness]);

  // Animate UV offset on the tube for a flowing shimmer effect. We use
  // a tiny oscillation so it doesn't feel like a traffic light.
  const uvOffset = (t * flowSpeed) % 1;

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.9}
        metalness={0.6}
        roughness={0.25}
        transparent
        opacity={0.88}
        side={THREE.DoubleSide}
      />
      {/* Soft halo via a scaled-up duplicate mesh with additive blending */}
      <mesh geometry={geometry} scale={[1.8, 1.8, 1.8]}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.18 - Math.abs(Math.sin(uvOffset * Math.PI * 2)) * 0.06}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </mesh>
  );
};
