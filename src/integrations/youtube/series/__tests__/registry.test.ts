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

  it("every series declares an aspect ratio and duration band", () => {
    for (const s of Object.values(SERIES)) {
      expect(["vertical", "horizontal"]).toContain(s.format.aspectRatio);
      expect(s.format.targetDurationSeconds.min).toBeGreaterThan(0);
      expect(s.format.targetDurationSeconds.max).toBeGreaterThan(
        s.format.targetDurationSeconds.min,
      );
    }
  });

  it("every series declares a motion profile (asmr | crisp | chaotic)", () => {
    for (const s of Object.values(SERIES)) {
      expect(["asmr", "crisp", "chaotic"]).toContain(s.format.motionProfile);
    }
  });

  it("motion profiles align to series role — Operator Mode crisp, Bot Beats chaotic, rest asmr", () => {
    expect(SERIES["operator-mode"].format.motionProfile).toBe("crisp");
    expect(SERIES["bot-beats"].format.motionProfile).toBe("chaotic");
    expect(SERIES.briefing.format.motionProfile).toBe("asmr");
    expect(SERIES["tomorrow-broke"].format.motionProfile).toBe("asmr");
    expect(SERIES["mind-wars"].format.motionProfile).toBe("asmr");
  });

  it("The Briefing is horizontal and packs 2-3 stories per episode", () => {
    expect(SERIES.briefing.format.aspectRatio).toBe("horizontal");
    expect(SERIES.briefing.format.storyCount?.min).toBeGreaterThanOrEqual(2);
    expect(SERIES.briefing.format.storyCount?.max).toBeGreaterThanOrEqual(3);
    expect(SERIES.briefing.format.targetDurationSeconds.min).toBeGreaterThanOrEqual(60);
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
