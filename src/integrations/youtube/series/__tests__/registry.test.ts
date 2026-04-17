import { describe, it, expect } from "vitest";
import {
  SERIES,
  listSeries,
  getSeries,
  assertSeriesEnabled,
} from "../registry.js";

describe("series/registry", () => {
  it("declares all five canonical series", () => {
    const slugs = Object.keys(SERIES).sort();
    expect(slugs).toEqual([
      "bot-beats",
      "briefing",
      "mind-wars",
      "operator-mode",
      "tomorrow-broke",
    ]);
  });

  it("ships four enabled series in v1; Bot Beats is deferred", () => {
    const enabled = listSeries({ onlyEnabled: true }).map((s) => s.slug).sort();
    expect(enabled).toEqual([
      "briefing",
      "mind-wars",
      "operator-mode",
      "tomorrow-broke",
    ]);
    expect(SERIES["bot-beats"].enabled).toBe(false);
  });

  it("each series has a unique kill-switch env, approval kind, and brand kit file", () => {
    const envs = new Set<string>();
    const kinds = new Set<string>();
    const brandKits = new Set<string>();
    for (const s of Object.values(SERIES)) {
      expect(envs.has(s.killSwitchEnv)).toBe(false);
      envs.add(s.killSwitchEnv);
      expect(kinds.has(s.approvalKind)).toBe(false);
      kinds.add(s.approvalKind);
      expect(brandKits.has(s.brandKitFile)).toBe(false);
      brandKits.add(s.brandKitFile);
    }
  });

  it("approvalKind encodes the slug so downstream bucketing stays stable", () => {
    for (const s of Object.values(SERIES)) {
      expect(s.approvalKind).toBe(`yt_short_draft_${s.slug}`);
    }
  });

  it("all enabled series declare ≥1 goal kpi id and a cron", () => {
    for (const s of listSeries({ onlyEnabled: true })) {
      expect(s.goalKpiIds.length).toBeGreaterThan(0);
      expect(s.cadence.cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
    }
  });

  it("getSeries throws on unknown slug", () => {
    // @ts-expect-error — runtime guard test
    expect(() => getSeries("not-a-show")).toThrow(/unknown series/);
  });

  it("assertSeriesEnabled refuses disabled series", () => {
    expect(() => assertSeriesEnabled("bot-beats")).toThrow(/disabled/);
    expect(() => assertSeriesEnabled("briefing")).not.toThrow();
  });

  it("cron schedules are staggered off :00 to avoid parallel fires", () => {
    const minutes = listSeries({ onlyEnabled: true }).map(
      (s) => Number(s.cadence.cron.split(" ")[0]),
    );
    for (const m of minutes) {
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThan(60);
    }
    expect(new Set(minutes).size).toBe(minutes.length);
  });
});
