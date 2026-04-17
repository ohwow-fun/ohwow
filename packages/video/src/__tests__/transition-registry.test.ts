import { describe, it, expect, afterEach } from "vitest";
import {
  registerTransition,
  unregisterTransition,
  getTransition,
  hasTransition,
  listTransitions,
  resolveTransition,
  TransitionConflictError,
  type TransitionBuilder,
} from "../transitions/registry";
import type { TransitionSpec } from "../spec/types";

describe("transition registry", () => {
  const testNames: string[] = [];

  afterEach(() => {
    for (const n of testNames) {
      try {
        unregisterTransition(n);
      } catch {
        /* ignore if built-in */
      }
    }
    testNames.length = 0;
  });

  function track(name: string): string {
    testNames.push(name);
    return name;
  }

  it("pre-registers fade, slide, wipe as built-ins", () => {
    expect(hasTransition("fade")).toBe(true);
    expect(hasTransition("slide")).toBe(true);
    expect(hasTransition("wipe")).toBe(true);
    const list = listTransitions();
    expect(list.find(e => e.name === "fade")?.builtin).toBe(true);
  });

  it("resolveTransition returns null for kind=none", () => {
    const spec: TransitionSpec = { kind: "none" };
    expect(resolveTransition(spec)).toBeNull();
  });

  it("resolveTransition returns presentation + timing for fade", () => {
    const spec: TransitionSpec = { kind: "fade", durationInFrames: 15 };
    const result = resolveTransition(spec);
    expect(result).not.toBeNull();
    expect(result?.presentation).toBeDefined();
    expect(result?.timing).toBeDefined();
  });

  it("resolveTransition honors spring config on fade", () => {
    const spec: TransitionSpec = {
      kind: "fade",
      durationInFrames: 20,
      spring: { damping: 10 },
    };
    expect(resolveTransition(spec)).not.toBeNull();
  });

  it("resolveTransition returns null for unregistered custom kind", () => {
    const spec = { kind: "no-such-transition", durationInFrames: 10 } as unknown as TransitionSpec;
    expect(resolveTransition(spec)).toBeNull();
  });

  it("registers a custom transition and resolves it", () => {
    const name = track("test-shader-dissolve");
    const build: TransitionBuilder = () => ({
      presentation: { component: () => null, props: {} } as never,
      timing: { getDurationInFrames: () => 30, getProgress: () => 0 } as never,
    });
    registerTransition(name, build, "test");
    expect(getTransition(name)).toBeDefined();
    const resolved = resolveTransition({ kind: name, durationInFrames: 30 } as unknown as TransitionSpec);
    expect(resolved).not.toBeNull();
  });

  it("throws on duplicate registration", () => {
    const name = track("test-dup-transition");
    const build: TransitionBuilder = () => ({
      presentation: {} as never,
      timing: { getDurationInFrames: () => 0, getProgress: () => 0 } as never,
    });
    registerTransition(name, build);
    expect(() => registerTransition(name, build)).toThrow(TransitionConflictError);
  });

  it("refuses to unregister a built-in", () => {
    expect(() => unregisterTransition("fade")).toThrow();
  });

  it("unregister returns false for unknown name", () => {
    expect(unregisterTransition("no-such-transition-xyz")).toBe(false);
  });
});
