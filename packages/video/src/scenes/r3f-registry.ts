/**
 * Registry for R3F primitives. R3FScene dispatches scene.params.primitives
 * entries to the registered React components by name.
 *
 * Phase 1 primitives (count-up-bar, versus-cards, particle-cloud,
 * orbiting-tags, glass-panel, ribbon-trail, number-sculpture,
 * benchmark-grid, model-card) register into this Map from their own
 * files so the registry is open-for-extension.
 */
import type React from "react";

export type R3FPrimitive = React.FC<{
  motionProfile?: string;
  durationInFrames?: number;
  [key: string]: unknown;
}>;

export const r3fRegistry = new Map<string, R3FPrimitive>();

export function registerR3FPrimitive(name: string, component: R3FPrimitive): void {
  if (r3fRegistry.has(name)) {
    throw new Error(`R3F primitive "${name}" already registered`);
  }
  r3fRegistry.set(name, component);
}

export function hasR3FPrimitive(name: string): boolean {
  return r3fRegistry.has(name);
}

export function listR3FPrimitives(): string[] {
  return Array.from(r3fRegistry.keys());
}
