import React from "react";
import type { SceneKind, Scene } from "../spec/types";
import { Scene1_You } from "./Scene1_You";
import { Scene2 as Scene2Drop } from "./Scene2_Drop";
import { Scene3 as Scene3Extraction } from "./Scene3_Extraction";
import { Scene5_ZoomOut } from "./Scene5_ZoomOut";
import { Scene6_Cloud } from "./Scene6_Cloud";

/**
 * Scene-kind → component registry.
 *
 * For Phase 1 parity, each component preserves the original hardcoded content,
 * noise seeds, stagger values and spring configs exactly. `params` is typed
 * on the spec but currently ignored by the components — Phase 5 will thread
 * params through to override the baked-in defaults for variant generation.
 */
export const sceneRegistry: Record<SceneKind, React.FC<{ scene: Scene }>> = {
  "prompts-grid": () => <Scene1_You />,
  drop: () => <Scene2Drop />,
  extraction: () => <Scene3Extraction />,
  "outcome-orbit": () => <Scene5_ZoomOut />,
  "cta-mesh": () => <Scene6_Cloud />,
};

export function renderScene(scene: Scene): React.ReactElement {
  const Comp = sceneRegistry[scene.kind];
  if (!Comp) {
    throw new Error(`Unknown scene kind: ${scene.kind}`);
  }
  return <Comp scene={scene} />;
}
