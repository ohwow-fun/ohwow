import React from "react";
import type { Scene } from "../spec/types";
import { Scene1_You } from "./Scene1_You";
import { Scene2 as Scene2Drop } from "./Scene2_Drop";
import { Scene3 as Scene3Extraction } from "./Scene3_Extraction";
import { Scene5_ZoomOut } from "./Scene5_ZoomOut";
import { Scene6_Cloud } from "./Scene6_Cloud";
import { StatsCounter } from "./StatsCounter";
import { TextTypewriter } from "./TextTypewriter";
import { AgentRoster } from "./AgentRoster";
import { TerminalLog } from "./TerminalLog";
import { BeforeAfter } from "./BeforeAfter";
import { NotificationStack } from "./NotificationStack";
import { QuoteCard } from "./QuoteCard";
import { WorkflowSteps } from "./WorkflowSteps";
import { ComposableScene } from "./ComposableScene";

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
  ["stats-counter", StatsCounter as SceneComponent],
  ["text-typewriter", TextTypewriter as SceneComponent],
  ["agent-roster", AgentRoster as SceneComponent],
  ["terminal-log", TerminalLog as SceneComponent],
  ["before-after", BeforeAfter as SceneComponent],
  ["notification-stack", NotificationStack as SceneComponent],
  ["quote-card", QuoteCard as SceneComponent],
  ["workflow-steps", WorkflowSteps as SceneComponent],
  ["composable", ComposableScene as SceneComponent],
]);

export class SceneKindConflictError extends Error {
  constructor(kind: string) {
    super(`Scene kind "${kind}" is already registered. Call unregisterSceneKind first if you intend to replace it.`);
    this.name = "SceneKindConflictError";
  }
}

export function registerSceneKind(kind: string, component: SceneComponent): void {
  if (registry.has(kind)) throw new SceneKindConflictError(kind);
  registry.set(kind, component);
}

export function unregisterSceneKind(kind: string): boolean {
  return registry.delete(kind);
}

export function hasSceneKind(kind: string): boolean {
  return registry.has(kind);
}

export function listSceneKinds(): string[] {
  return Array.from(registry.keys());
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
