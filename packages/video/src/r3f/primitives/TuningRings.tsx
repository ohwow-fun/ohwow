/**
 * r3f.tuning-rings — two (or more) concentric chrome rings that
 * counter-rotate slowly behind the scene's hero content. Reads as
 * "instrument / tuner / dial" — a subtle mechanical texture that
 * sells "modern / futurist / data-instrument" without competing for
 * attention.
 *
 * Each ring has tiny notches around its circumference (implemented as
 * a dashed torus via alphaMap-like density cuts) so the rotation is
 * visually perceptible. One warm chrome, one cool chrome by default.
 *
 * Params:
 *   radius?:    number — base radius of the inner ring (default 2.2)
 *   gap?:       number — radial gap between inner and outer rings (default 0.8)
 *   thickness?: number — tube thickness (default 0.02)
 *   innerColor?: string (default warm #e3b58a)
 *   outerColor?: string (default cool #9ec7ff)
 *   innerSpeed?: number — inner ring radians/sec (default 0.12)
 *   outerSpeed?: number — outer ring radians/sec (default -0.08 — counter)
 *   depthOffset?: number — push back in z so rings sit behind content (default -0.5)
 *   opacity?:    number — overall alpha for ambient feel (default 0.6)
 */
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";

interface TuningRingsProps {
  radius?: number;
  gap?: number;
  thickness?: number;
  innerColor?: string;
  outerColor?: string;
  innerSpeed?: number;
  outerSpeed?: number;
  depthOffset?: number;
  opacity?: number;
  motionProfile?: string;
}

export const TuningRings: React.FC<TuningRingsProps> = ({
  radius = 2.2,
  gap = 0.8,
  thickness = 0.02,
  innerColor = "#e3b58a",
  outerColor = "#9ec7ff",
  innerSpeed = 0.12,
  outerSpeed = -0.08,
  depthOffset = -0.5,
  opacity = 0.6,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  // Build each torus geometry once. Using thin torus gives a crisp ring
  // that still catches some env light on its shaded side.
  const innerGeo = useMemo(
    () => new THREE.TorusGeometry(radius, thickness, 8, 128),
    [radius, thickness],
  );
  const outerGeo = useMemo(
    () => new THREE.TorusGeometry(radius + gap, thickness * 1.2, 8, 160),
    [radius, gap, thickness],
  );

  // Tick marks — short line segments around each ring giving that
  // mechanical-dial quality. These are separate meshes that rotate
  // with the ring.
  const innerTicks = useMemo(() => buildTicks(radius, 48, thickness * 4), [radius, thickness]);
  const outerTicks = useMemo(() => buildTicks(radius + gap, 72, thickness * 3), [radius, gap, thickness]);

  const innerRot = t * innerSpeed;
  const outerRot = t * outerSpeed;

  return (
    <group position={[0, 0, depthOffset]}>
      {/* Inner warm chrome ring */}
      <group rotation={[0, 0, innerRot]}>
        <mesh geometry={innerGeo}>
          <meshStandardMaterial
            color={innerColor}
            metalness={0.85}
            roughness={0.22}
            transparent
            opacity={opacity}
          />
        </mesh>
        <lineSegments geometry={innerTicks}>
          <lineBasicMaterial color={innerColor} transparent opacity={opacity * 0.7} />
        </lineSegments>
      </group>

      {/* Outer cool chrome ring */}
      <group rotation={[0, 0, outerRot]}>
        <mesh geometry={outerGeo}>
          <meshStandardMaterial
            color={outerColor}
            metalness={0.9}
            roughness={0.25}
            transparent
            opacity={opacity * 0.85}
          />
        </mesh>
        <lineSegments geometry={outerTicks}>
          <lineBasicMaterial color={outerColor} transparent opacity={opacity * 0.55} />
        </lineSegments>
      </group>
    </group>
  );
};

/**
 * Build a ring of short radial tick marks — tickCount line segments
 * arrayed around the circle, each pointing radially outward. Gives the
 * ring a dial/odometer quality without actual numerals.
 */
function buildTicks(ringRadius: number, tickCount: number, tickLength: number): THREE.BufferGeometry {
  const positions = new Float32Array(tickCount * 2 * 3);
  for (let i = 0; i < tickCount; i++) {
    const angle = (i / tickCount) * Math.PI * 2;
    const x1 = Math.cos(angle) * ringRadius;
    const y1 = Math.sin(angle) * ringRadius;
    const x2 = Math.cos(angle) * (ringRadius + tickLength);
    const y2 = Math.sin(angle) * (ringRadius + tickLength);
    positions[i * 6 + 0] = x1;
    positions[i * 6 + 1] = y1;
    positions[i * 6 + 2] = 0;
    positions[i * 6 + 3] = x2;
    positions[i * 6 + 4] = y2;
    positions[i * 6 + 5] = 0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geo;
}
