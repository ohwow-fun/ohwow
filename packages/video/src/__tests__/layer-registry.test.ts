import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import {
  registerLayerPrimitive,
  unregisterLayerPrimitive,
  getLayerPrimitive,
  hasLayerPrimitive,
  listLayerPrimitives,
  LayerPrimitiveConflictError,
} from "../layers/registry";

describe("layer primitive registry", () => {
  const testNames: string[] = [];

  afterEach(() => {
    for (const n of testNames) {
      try {
        unregisterLayerPrimitive(n);
      } catch {
        /* ignore if unregister throws on built-in */
      }
    }
    testNames.length = 0;
  });

  function track(name: string): string {
    testNames.push(name);
    return name;
  }

  it("pre-registers all 19 built-in primitives", () => {
    const names = listLayerPrimitives().map(e => e.name).sort();
    expect(names).toContain("aurora");
    expect(names).toContain("bokeh");
    expect(names).toContain("video-clip");
    expect(names.length).toBeGreaterThanOrEqual(19);
  });

  it("built-in entries are flagged as builtin:true", () => {
    const aurora = listLayerPrimitives().find(e => e.name === "aurora");
    expect(aurora).toBeDefined();
    expect(aurora?.builtin).toBe(true);
  });

  it("getLayerPrimitive returns component + whitelist for a built-in", () => {
    const entry = getLayerPrimitive("aurora");
    expect(entry).toBeDefined();
    expect(entry?.paramWhitelist.has("colors")).toBe(true);
    expect(entry?.paramWhitelist.has("not-a-real-key")).toBe(false);
  });

  it("returns undefined for an unknown primitive", () => {
    expect(getLayerPrimitive("no-such-primitive-xyz")).toBeUndefined();
    expect(hasLayerPrimitive("no-such-primitive-xyz")).toBe(false);
  });

  it("registers a custom primitive and finds it", () => {
    const name = track("test-custom-1");
    const Comp: React.FC<Record<string, unknown>> = () => null;
    registerLayerPrimitive(name, Comp, ["foo", "bar"], "test");
    const entry = getLayerPrimitive(name);
    expect(entry).toBeDefined();
    expect(entry?.paramWhitelist.has("foo")).toBe(true);
    expect(listLayerPrimitives().find(e => e.name === name)?.builtin).toBe(false);
  });

  it("throws on duplicate registration", () => {
    const name = track("test-dup");
    const Comp: React.FC<Record<string, unknown>> = () => null;
    registerLayerPrimitive(name, Comp, ["x"]);
    expect(() => registerLayerPrimitive(name, Comp, ["y"])).toThrow(LayerPrimitiveConflictError);
  });

  it("refuses to unregister a built-in", () => {
    expect(() => unregisterLayerPrimitive("aurora")).toThrow();
  });

  it("unregister returns false for unknown name", () => {
    expect(unregisterLayerPrimitive("no-such-primitive-xyz")).toBe(false);
  });

  it("allows re-registering a name after unregister", () => {
    const name = track("test-reregister");
    const Comp: React.FC<Record<string, unknown>> = () => null;
    registerLayerPrimitive(name, Comp, ["a"]);
    unregisterLayerPrimitive(name);
    registerLayerPrimitive(name, Comp, ["b"]);
    expect(getLayerPrimitive(name)?.paramWhitelist.has("b")).toBe(true);
  });

  it("accepts Set or Array for whitelist", () => {
    const n1 = track("test-whitelist-set");
    const n2 = track("test-whitelist-arr");
    const Comp: React.FC<Record<string, unknown>> = () => null;
    registerLayerPrimitive(n1, Comp, new Set(["x"]));
    registerLayerPrimitive(n2, Comp, ["y"]);
    expect(getLayerPrimitive(n1)?.paramWhitelist.has("x")).toBe(true);
    expect(getLayerPrimitive(n2)?.paramWhitelist.has("y")).toBe(true);
  });
});
