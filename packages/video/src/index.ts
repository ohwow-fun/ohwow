import { registerRoot } from "remotion";
import { Root } from "./Root";

export * from "./spec/types";
export * from "./spec/kinds";
export {
  VideoSpecSchema,
  parseVideoSpec,
  safeParseVideoSpec,
  BrandTokensSchema,
  AudioRefSchema,
  CaptionSpecSchema,
  VideoPaletteSchema,
  TransitionSpecSchema,
  SceneSchema,
} from "./spec/schema";
export {
  lintVideoSpec,
  formatLintIssue,
  formatLintResult,
  type LintIssue,
  type LintResult,
  type LintSeverity,
  type LintOptions,
} from "./spec/lint";
export {
  registerSceneKind,
  unregisterSceneKind,
  hasSceneKind,
  listSceneKinds,
  renderScene,
  SceneKindConflictError,
} from "./scenes/registry";
export {
  registerTransition,
  unregisterTransition,
  getTransition,
  hasTransition,
  listTransitions,
  resolveTransition,
  TransitionConflictError,
  type ResolvedTransition,
  type TransitionBuilder,
  type TransitionCatalogEntry,
} from "./transitions/registry";
export * from "./motion/generative";
export * from "./layers";
// NOTE: scene-hash.ts imports "node:crypto" and is Node-side only (used
// by the media-asset cache, not at render time). Do NOT re-export it
// from this module — Remotion's webpack bundler follows every export
// in the entry file and UnhandledSchemeError's on node:* URIs. If you
// need hashScene in Node code, import directly from the source path:
//   import { hashScene } from "@ohwow/video/dist/render/scene-hash";
export {
  BLOCKS,
  getBlock,
  listBlocks,
  lowerThird,
  statCard,
  captionStrip,
  titleCard,
  quoteCard,
  bulletList,
  metricDashboard,
  logoReveal,
  type VideoBlock,
  type BlockCategory,
  type BlockParamField,
} from "./blocks";

registerRoot(Root);
