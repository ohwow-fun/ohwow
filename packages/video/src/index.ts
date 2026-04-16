import { registerRoot } from "remotion";
import { Root } from "./Root";

export * from "./spec/types";
export * from "./spec/kinds";
export { registerSceneKind, renderScene } from "./scenes/registry";
export * from "./motion/generative";
export * from "./layers";

registerRoot(Root);
