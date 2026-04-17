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
import { R3FScene } from "./R3FScene";

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
  ["r3f-scene", R3FScene as SceneComponent],
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

/**
 * Scene-level error boundary. When a scene component throws during
 * render (e.g., an AI-generated custom scene with a runtime bug, or a
 * malformed params payload reaching an R3F primitive), we don't want
 * the entire composition to fail — we'd rather render a graceful
 * fallback and keep the rest of the video intact.
 *
 * The fallback is a minimal composable-style background with the
 * scene's narration text if we can find it, so audio/timing stay
 * consistent and the viewer sees something reasonable instead of a
 * render crash.
 */
interface SceneErrorBoundaryProps {
  children: React.ReactNode;
  sceneId: string;
  sceneKind: string;
  fallback: React.ReactNode;
}

interface SceneErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

class SceneErrorBoundary extends React.Component<SceneErrorBoundaryProps, SceneErrorBoundaryState> {
  state: SceneErrorBoundaryState = { hasError: false, errorMessage: null };

  static getDerivedStateFromError(error: Error): SceneErrorBoundaryState {
    return { hasError: true, errorMessage: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.warn(
      `[scene-registry] scene crashed: id=${this.props.sceneId} kind=${this.props.sceneKind} — ${error.message}`,
      info.componentStack,
    );
  }

  render() {
    if (this.state.hasError) return <>{this.props.fallback}</>;
    return <>{this.props.children}</>;
  }
}

/**
 * Fallback scene rendered when the primary scene component throws. A
 * calm dark background + the scene's narration text as a simple title.
 * Keeps the composition coherent when one scene breaks.
 */
const FallbackScene: React.FC<{ narration?: string; sceneKind: string }> = ({ narration, sceneKind }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: "linear-gradient(135deg, #0a1629 0%, #14203a 100%)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "0 120px",
      textAlign: "center",
      color: "rgba(255, 255, 255, 0.92)",
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: narration ? 44 : 28,
      fontWeight: 600,
      lineHeight: 1.35,
    }}
  >
    {narration || `[Scene render failed: ${sceneKind}]`}
  </div>
);

export function renderScene(scene: Scene): React.ReactElement {
  const Comp = registry.get(scene.kind);
  if (!Comp) {
    throw new Error(
      `Unknown scene kind: "${scene.kind}". Registered: ${[...registry.keys()].join(", ")}`,
    );
  }
  const narration = (scene as { narration?: string }).narration;
  return (
    <SceneErrorBoundary
      sceneId={scene.id}
      sceneKind={scene.kind}
      fallback={<FallbackScene narration={narration} sceneKind={scene.kind} />}
    >
      <Comp
        params={(scene.params ?? {}) as Record<string, unknown>}
        durationInFrames={scene.durationInFrames}
      />
    </SceneErrorBoundary>
  );
}
