import type { Scene } from "../spec/types";
import type { ComposableSceneParams } from "../scenes/ComposableScene";

export type BlockCategory = "titling" | "metrics" | "narrative" | "overlay" | "cta";

export interface BlockParamField {
  type: "string" | "number" | "boolean" | "string[]" | "object" | "object[]";
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface VideoBlock<Params = Record<string, unknown>> {
  /** Stable identifier used by specs and the CLI add command. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Grouping for catalog browsing. */
  category: BlockCategory;
  /** One-line description used by the CLI, skills, and catalog.json. */
  description: string;
  /** Default scene length when the caller doesn't override. */
  defaultDurationFrames: number;
  /** Shape-documenting schema for the block's params (agent consumable). */
  paramSchema: Record<string, BlockParamField>;
  /** Returns an Omit<Scene, "id"> ready to be wrapped with an id by the spec. */
  build(params: Partial<Params>): Omit<Scene, "id"> & { kind: "composable"; params: Partial<ComposableSceneParams> };
}
