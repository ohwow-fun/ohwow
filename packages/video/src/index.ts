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
export { registerSceneKind, hasSceneKind, listSceneKinds, renderScene } from "./scenes/registry";
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

registerRoot(Root);
