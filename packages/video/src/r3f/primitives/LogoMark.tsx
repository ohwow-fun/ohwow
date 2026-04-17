/**
 * r3f.logo-mark — a small, always-on ohwow ring that sits in a corner
 * of the frame as a persistent brand signature. Use this in intro/outro
 * scenes AFTER the logo-reveal ritual so the ring stays on-screen as
 * viewers' peripheral vision locks the brand in.
 *
 * Pairs with r3f.logo-reveal (which runs the full ember-to-ring
 * ceremony); LogoMark is the quieter persistent form.
 *
 * Params:
 *   position?: [x, y, z] — where to plant the mark (default top-right ~ [4.2, 2.2, 0])
 *   size?:     number — world-units diameter (default 0.8)
 *   opacity?:  number — overall alpha (default 0.92)
 *   rotateSpeed?: number — radians/sec slow rotation (default 0.06)
 *   breath?:   boolean — subtle breath-scale (default true)
 */
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, staticFile } from "remotion";
import { Billboard } from "@react-three/drei";
import * as THREE from "three";

interface LogoMarkProps {
  position?: [number, number, number];
  size?: number;
  opacity?: number;
  rotateSpeed?: number;
  breath?: boolean;
  logoUrl?: string;
  motionProfile?: string;
}

const LOGO_PATH = "ohwow-logo.png";

export const LogoMark: React.FC<LogoMarkProps> = ({
  position = [4.2, 2.2, 0],
  size = 0.8,
  opacity = 0.92,
  rotateSpeed = 0.06,
  breath = true,
  logoUrl,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const resolvedUrl = useMemo(() => logoUrl ?? staticFile(LOGO_PATH), [logoUrl]);

  const logoTexture = useMemo(() => {
    const loader = new THREE.TextureLoader();
    const tex = loader.load(resolvedUrl);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [resolvedUrl]);

  const breathScale = breath ? 1 + Math.sin(t * 0.8) * 0.04 : 1;
  const rotation = t * rotateSpeed;

  return (
    <Billboard position={position}>
      <mesh scale={[size * breathScale, size * breathScale, 1]} rotation={[0, 0, rotation]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={logoTexture}
          transparent
          opacity={opacity}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </Billboard>
  );
};
