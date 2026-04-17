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
// Side-effect import: registers all r3f.* primitives at module load.
import "../r3f/register";

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

// ─── Demo primitive (kept for Phase 0 smoke testing) ──────────────────
// A single chrome cube that slowly rotates. Used by specs/r3f-demo.json.
// The real Phase 1 primitives live under src/r3f/primitives/.

const DemoCube: React.FC<{
  color?: string;
  motionProfile?: string;
}> = ({ color = "#f4eadb", motionProfile }) => {
  const frame = useCurrentFrame();
  const profile = getMotionProfile(motionProfile);
  const t = frame / 30;
  const rotationY = t * 0.4;
  const rotationX = Math.sin(t * 0.3) * 0.15;
  const breath = profile.breathAmp > 0
    ? 1 + Math.sin((frame / profile.breathPeriodFrames) * Math.PI * 2) * profile.breathAmp
    : 1;
  void asmrEasingDeep;

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

r3fRegistry.set("r3f.demo-cube", DemoCube as unknown as Parameters<typeof r3fRegistry.set>[1]);
