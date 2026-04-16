import React from "react";
import type { Scene } from "../spec/types";
import { Scene1_You } from "./Scene1_You";
import { Scene2 as Scene2Drop } from "./Scene2_Drop";
import { Scene3 as Scene3Extraction } from "./Scene3_Extraction";
import { Scene5_ZoomOut } from "./Scene5_ZoomOut";
import { Scene6_Cloud } from "./Scene6_Cloud";

type SceneComponent = React.FC<{
  params?: Record<string, unknown>;
  durationInFrames?: number;
}>;

const registry = new Map<string, SceneComponent>([
  ["prompts-grid", Scene1_You as SceneComponent],
  ["drop", Scene2Drop as SceneComponent],
  ["extraction", Scene3Extraction as SceneComponent],
  ["outcome-orbit", Scene5_ZoomOut as SceneComponent],
  ["cta-mesh", Scene6_Cloud as SceneComponent],
]);

export function registerSceneKind(kind: string, component: SceneComponent): void {
  registry.set(kind, component);
}

export function renderScene(scene: Scene): React.ReactElement {
  const Comp = registry.get(scene.kind);
  if (!Comp) {
    throw new Error(
      `Unknown scene kind: "${scene.kind}". Registered: ${[...registry.keys()].join(", ")}`,
    );
  }
  return (
    <Comp
      params={(scene.params ?? {}) as Record<string, unknown>}
      durationInFrames={scene.durationInFrames}
    />
  );
}
