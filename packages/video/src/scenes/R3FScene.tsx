/**
 * R3FScene — the bridge between Remotion's frame timeline and React Three
 * Fiber's WebGL canvas. Any scene.kind === "r3f-scene" renders through
 * this, with a list of 3D primitives composed in depth.
 *
 * Params shape (scene.params):
 *   {
 *     primitives: Array<{ primitive: string; params?: object }>
 *     camera?: { position?: [x,y,z]; fov?: number; lookAt?: [x,y,z] }
 *     background?: string  // hex or rgb
 *     fog?: { color: string; near: number; far: number }
 *     motionProfile?: 'asmr'|'crisp'|'chaotic'
 *   }
 *
 * The R3F primitive registry (./r3f-registry.ts) dispatches each entry
 * in `primitives` to its registered React component. See the Phase 0
 * demo registration of `r3f.demo-cube` in this file.
 */

import React, { Suspense } from "react";
import { ThreeCanvas } from "@remotion/three";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { asmrEasingDeep, getMotionProfile } from "../motion/asmr";
import { r3fRegistry } from "./r3f-registry";

interface CameraSpec {
  position?: [number, number, number];
  fov?: number;
  lookAt?: [number, number, number];
}

interface FogSpec {
  color: string;
  near: number;
  far: number;
}

interface R3FSceneParams {
  primitives?: Array<{ primitive: string; params?: Record<string, unknown> }>;
  camera?: CameraSpec;
  background?: string;
  fog?: FogSpec;
  motionProfile?: string;
}

export const R3FScene: React.FC<{
  params?: Partial<R3FSceneParams>;
  durationInFrames?: number;
}> = ({ params = {}, durationInFrames }) => {
  const { width, height } = useVideoConfig();
  const camera = params.camera ?? {};
  const primitives = params.primitives ?? [];
  const bg = params.background ?? "#0a1629";

  return (
    <ThreeCanvas
      width={width}
      height={height}
      camera={{
        position: camera.position ?? [0, 0, 8],
        fov: camera.fov ?? 45,
      }}
      gl={{ antialias: true }}
      style={{ background: bg }}
    >
      <Suspense fallback={null}>
        {params.fog && (
          <fog attach="fog" args={[params.fog.color, params.fog.near, params.fog.far]} />
        )}
        <ambientLight intensity={0.35} />
        <directionalLight position={[5, 8, 5]} intensity={0.9} />
        <pointLight position={[-4, 2, 6]} intensity={0.4} color="#ffcc88" />
        {primitives.map((entry, i) => {
          const Prim = r3fRegistry.get(entry.primitive);
          if (!Prim) {
            // eslint-disable-next-line no-console
            console.warn(`[r3f-scene] unknown primitive: ${entry.primitive}`);
            return null;
          }
          return (
            <Prim
              key={`${entry.primitive}-${i}`}
              {...(entry.params ?? {})}
              motionProfile={params.motionProfile}
              durationInFrames={durationInFrames}
            />
          );
        })}
      </Suspense>
    </ThreeCanvas>
  );
};

// ─── Demo primitive — proves the Remotion↔R3F pipeline works ──────────
// A single chrome cube that slowly rotates and breathes with ASMR easing.
// Used by the Phase 0 verification render; real primitives come in Phase 1.

const DemoCube: React.FC<{
  color?: string;
  motionProfile?: string;
  durationInFrames?: number;
}> = ({ color = "#f4eadb", motionProfile }) => {
  const frame = useCurrentFrame();
  const profile = getMotionProfile(motionProfile);

  // Slow rotation driven by ASMR easing.
  const t = frame / 30; // seconds
  const rotationY = t * 0.4; // ~0.4 rad/sec = very slow turn
  const rotationX = Math.sin(t * 0.3) * 0.15;

  // Breath-scale pulse (only when ASMR profile is active).
  const breath = profile.breathAmp > 0
    ? 1 + Math.sin((frame / profile.breathPeriodFrames) * Math.PI * 2) * profile.breathAmp
    : 1;
  void asmrEasingDeep; // reserved for cross-scene use

  return (
    <mesh rotation={[rotationX, rotationY, 0]} scale={[breath, breath, breath]}>
      <boxGeometry args={[2, 2, 2]} />
      <meshStandardMaterial
        color={color}
        metalness={0.9}
        roughness={0.18}
        envMapIntensity={1.0}
      />
    </mesh>
  );
};

// Register demo-cube at module load. Real primitives register similarly
// from their own files in Phase 1.
r3fRegistry.set("r3f.demo-cube", DemoCube as R3FPrimitive);

export type R3FPrimitive = React.FC<{
  motionProfile?: string;
  durationInFrames?: number;
  [key: string]: unknown;
}>;
