import {
  springTiming,
  linearTiming,
  type TransitionTiming,
  type TransitionPresentation,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import type { TransitionSpec } from "../spec/types";

/**
 * A resolved transition: the presentation component + its timing curve.
 * The Remotion TransitionPresentation is generic over its own props — we
 * type it as unknown here so custom transitions can use any prop shape.
 */
export interface ResolvedTransition {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  presentation: TransitionPresentation<any>;
  timing: TransitionTiming;
}

export type TransitionBuilder = (spec: TransitionSpec) => ResolvedTransition;

export interface TransitionCatalogEntry {
  name: string;
  description?: string;
  builtin: boolean;
}

interface RegistryEntry {
  build: TransitionBuilder;
  description?: string;
  builtin: boolean;
}

const registry = new Map<string, RegistryEntry>();

export class TransitionConflictError extends Error {
  constructor(name: string) {
    super(`Transition "${name}" is already registered. Call unregisterTransition first to replace it.`);
    this.name = "TransitionConflictError";
  }
}

function register(
  name: string,
  build: TransitionBuilder,
  description: string | undefined,
  builtin: boolean,
): void {
  if (registry.has(name)) throw new TransitionConflictError(name);
  registry.set(name, { build, description, builtin });
}

export function registerTransition(
  name: string,
  build: TransitionBuilder,
  description?: string,
): void {
  register(name, build, description, false);
}

export function unregisterTransition(name: string): boolean {
  const entry = registry.get(name);
  if (!entry) return false;
  if (entry.builtin) {
    throw new Error(`Cannot unregister built-in transition "${name}".`);
  }
  registry.delete(name);
  return true;
}

export function getTransition(name: string): TransitionBuilder | undefined {
  return registry.get(name)?.build;
}

export function hasTransition(name: string): boolean {
  return registry.has(name);
}

export function listTransitions(): TransitionCatalogEntry[] {
  return Array.from(registry.entries()).map(([name, e]) => ({
    name,
    description: e.description,
    builtin: e.builtin,
  }));
}

/**
 * Resolve a TransitionSpec to its presentation + timing. Returns null for
 * kind === "none" (callers should skip inserting a Transition in that case)
 * or when the kind is unregistered.
 */
export function resolveTransition(spec: TransitionSpec): ResolvedTransition | null {
  if (spec.kind === "none") return null;
  const build = getTransition(spec.kind);
  if (!build) return null;
  return build(spec);
}

// ─── Built-in registrations ─────────────────────────────────────────────────

register(
  "fade",
  (t: TransitionSpec) => {
    // Narrow: we know kind === "fade" here by dispatch.
    const spec = t as Extract<TransitionSpec, { kind: "fade" }>;
    const timing: TransitionTiming = spec.spring
      ? springTiming({
          config: { damping: spec.spring.damping },
          durationInFrames: spec.durationInFrames,
          durationRestThreshold: spec.spring.durationRestThreshold ?? 0.001,
        })
      : linearTiming({ durationInFrames: spec.durationInFrames });
    return { presentation: fade(), timing };
  },
  "Cross-fade between scenes. Spring-timed when spec.spring is set, else linear.",
  true,
);

register(
  "slide",
  (t: TransitionSpec) => {
    const spec = t as Extract<TransitionSpec, { kind: "slide" }>;
    return {
      presentation: slide({ direction: spec.direction }),
      timing: linearTiming({ durationInFrames: spec.durationInFrames }),
    };
  },
  "Directional slide. direction: 'from-left' | 'from-right'.",
  true,
);

register(
  "wipe",
  (t: TransitionSpec) => {
    const spec = t as Extract<TransitionSpec, { kind: "wipe" }>;
    return {
      presentation: wipe({ direction: spec.direction }),
      timing: linearTiming({ durationInFrames: spec.durationInFrames }),
    };
  },
  "Directional wipe. direction: 'from-left' | 'from-right' | 'from-top' | 'from-bottom'.",
  true,
);

// "none" is a sentinel kind: resolveTransition returns null so the composition
// skips inserting a Transition node. We don't register a builder for it —
// dispatch short-circuits on kind === "none".
