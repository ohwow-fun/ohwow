/**
 * Music-ducking regression test.
 *
 * What this test pins and why:
 * - `voiceWindowsFromRefs` must NEVER silently drop a voiceover that is
 *   missing `durationFrames`. Until April 2026 it did, which made the ducker
 *   go flat under voice in any re-render that skipped the per-scene TTS
 *   path. See the `/tmp/rerender-briefing-louder-music.mjs` post-mortem in
 *   commit-log: founder watched a 50s briefing and the music bed sat at a
 *   constant -14 dB under the voiceover instead of dipping ~-4 dB or more.
 * - The envelope under a voice window must dip by at least 4 dB versus the
 *   1-second window JUST BEFORE the voiceover starts. If the delta is
 *   smaller, ducking is absent or weak regardless of what the source claims.
 * - Default attack/release (15f / 30f at 30fps) and ducked-volume ceiling
 *   (0.12 linear ≈ -18 dB) are locked in by importing the shared
 *   `MUSIC_DUCK_DEFAULTS` constant — changing them here forces a review
 *   against this test's assertions.
 *
 * This is a math-level test on the `buildMusicVolume` curve, not a full
 * render. The curve is the single source of truth for per-frame music
 * volume (Remotion samples `<Audio volume={fn}>` per-frame), so simulating
 * the curve at 100-frame resolution is exactly what Remotion feeds to the
 * audio track at render time.
 */
import { describe, it, expect } from "vitest";
import {
  buildMusicVolume,
  duckedVolumeFor,
  MUSIC_DUCK_DEFAULTS,
  voiceWindowsFromRefs,
} from "../SpecDrivenComposition";
import type { AudioRef } from "../spec/types";

const TOTAL_FRAMES = 1500; // 50s @ 30fps

function linearToDb(v: number): number {
  return v <= 0 ? -120 : 20 * Math.log10(v);
}

/** Sample the music-volume curve at N evenly spaced frames and return dB. */
function sampleEnvelopeDb(
  fn: (f: number) => number,
  startFrame: number,
  endFrame: number,
  step = 1,
): number[] {
  const out: number[] = [];
  for (let f = startFrame; f <= endFrame; f += step) {
    out.push(linearToDb(fn(f)));
  }
  return out;
}

describe("music ducking — voiceWindowsFromRefs", () => {
  it("materializes a window from startFrame + durationFrames when both are present", () => {
    const refs: AudioRef[] = [
      { src: "v1.mp3", startFrame: 90, durationFrames: 251, volume: 1 },
      { src: "v2.mp3", startFrame: 366, durationFrames: 351, volume: 1 },
    ];
    const windows = voiceWindowsFromRefs(refs, TOTAL_FRAMES);
    expect(windows).toEqual([
      { start: 90, end: 341 },
      { start: 366, end: 717 },
    ]);
  });

  it("infers end from next voiceover when durationFrames is missing (no silent drop)", () => {
    // Regression: before April 2026, refs without durationFrames were
    // filtered out entirely. A spec with one voiceover + no durationFrames
    // would yield ZERO windows, and the ducker would silently return
    // `baseVolume` flat. This assertion makes that a hard test failure.
    const refs: AudioRef[] = [
      { src: "v1.mp3", startFrame: 100, volume: 1 },
      { src: "v2.mp3", startFrame: 500, volume: 1 },
    ];
    const windows = voiceWindowsFromRefs(refs, TOTAL_FRAMES);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ start: 100, end: 499 });
    expect(windows[1]).toEqual({ start: 500, end: TOTAL_FRAMES });
  });

  it("infers end from totalFrames for a trailing voiceover with no durationFrames", () => {
    const refs: AudioRef[] = [{ src: "v1.mp3", startFrame: 65, volume: 0.9 }];
    const windows = voiceWindowsFromRefs(refs, TOTAL_FRAMES);
    // This is the EXACT shape the founder watched when ducking sounded
    // absent: one voiceover, startFrame set, no durationFrames.
    expect(windows).toEqual([{ start: 65, end: TOTAL_FRAMES }]);
  });

  it("returns an empty array when there are no voiceovers", () => {
    expect(voiceWindowsFromRefs([], TOTAL_FRAMES)).toEqual([]);
  });
});

describe("music ducking — buildMusicVolume curve", () => {
  it("dips music by at least 4 dB inside a voice window vs. 1s before it", () => {
    const baseVolume = 0.9;
    const windows = voiceWindowsFromRefs(
      [
        // One voiceover at 10s..20s (frames 300..600) with explicit duration.
        { src: "v.mp3", startFrame: 300, durationFrames: 300, volume: 1 },
      ],
      TOTAL_FRAMES,
    );

    const fn = buildMusicVolume({
      baseVolume,
      duckedVolume: duckedVolumeFor(baseVolume),
      attackFrames: MUSIC_DUCK_DEFAULTS.attackFrames,
      releaseFrames: MUSIC_DUCK_DEFAULTS.releaseFrames,
      musicStartFrame: 0,
      voiceWindows: windows,
    });

    // Pre-window: 1s BEFORE attack ramp starts. Attack starts at
    // frame 300 - 15 = 285, so probe at frame 255 (1s before attack).
    const preDb = linearToDb(fn(255));
    // Mid-window: fully ducked plateau (attack ramp is done by frame 315).
    const midDb = linearToDb(fn(450));
    const dipDb = midDb - preDb;

    expect(preDb).toBeCloseTo(linearToDb(baseVolume), 1);
    // 0.9 -> 0.12 = 20*log10(0.12/0.9) ≈ -17.5 dB.
    expect(dipDb).toBeLessThan(-4);
  });

  it("dips music even when voiceover lacks durationFrames (regression test)", () => {
    // This is the founder-reported bug: a voiceover without durationFrames
    // used to disable ducking entirely. `voiceWindowsFromRefs` now infers
    // a window, so the curve must dip inside it.
    const baseVolume = 0.9;
    const refs: AudioRef[] = [{ src: "v.mp3", startFrame: 300, volume: 1 }];
    const windows = voiceWindowsFromRefs(refs, TOTAL_FRAMES);

    const fn = buildMusicVolume({
      baseVolume,
      duckedVolume: duckedVolumeFor(baseVolume),
      attackFrames: MUSIC_DUCK_DEFAULTS.attackFrames,
      releaseFrames: MUSIC_DUCK_DEFAULTS.releaseFrames,
      musicStartFrame: 0,
      voiceWindows: windows,
    });

    const preDb = linearToDb(fn(255));
    const midDb = linearToDb(fn(600));
    const dipDb = midDb - preDb;

    expect(dipDb).toBeLessThan(-4);
  });

  it("holds music at baseVolume when there are no voiceovers", () => {
    const baseVolume = 0.9;
    const fn = buildMusicVolume({
      baseVolume,
      duckedVolume: duckedVolumeFor(baseVolume),
      attackFrames: MUSIC_DUCK_DEFAULTS.attackFrames,
      releaseFrames: MUSIC_DUCK_DEFAULTS.releaseFrames,
      musicStartFrame: 0,
      voiceWindows: [],
    });
    for (const db of sampleEnvelopeDb(fn, 0, 900, 30)) {
      expect(db).toBeCloseTo(linearToDb(baseVolume), 1);
    }
  });

  it("ramps through attack and release (no cliff edges)", () => {
    const baseVolume = 0.9;
    const fn = buildMusicVolume({
      baseVolume,
      duckedVolume: duckedVolumeFor(baseVolume),
      attackFrames: MUSIC_DUCK_DEFAULTS.attackFrames,
      releaseFrames: MUSIC_DUCK_DEFAULTS.releaseFrames,
      musicStartFrame: 0,
      voiceWindows: [{ start: 300, end: 600 }],
    });
    // During attack (frames 285..300) volume must be monotone decreasing.
    let prev = fn(285);
    for (let f = 286; f <= 300; f++) {
      const v = fn(f);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
    // During release (frames 600..630) volume must be monotone increasing.
    prev = fn(600);
    for (let f = 601; f <= 630; f++) {
      const v = fn(f);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });
});

describe("music ducking — defaults are locked", () => {
  it("keeps attack/release defaults at 15f / 30f (500ms / 1s @ 30fps)", () => {
    // If you're changing these, read the comment in MUSIC_DUCK_DEFAULTS
    // and confirm the dip assertion above still holds.
    expect(MUSIC_DUCK_DEFAULTS.attackFrames).toBe(15);
    expect(MUSIC_DUCK_DEFAULTS.releaseFrames).toBe(30);
  });

  it("keeps duck ceiling at 0.12 linear (~-18 dB)", () => {
    expect(MUSIC_DUCK_DEFAULTS.duckCeilingLinear).toBeCloseTo(0.12, 3);
    expect(duckedVolumeFor(0.9)).toBeCloseTo(0.12, 3);
    // Base of 0.2 -> duck to 0.08 (floor fraction), not to 0.12 (ceiling).
    expect(duckedVolumeFor(0.2)).toBeCloseTo(0.08, 3);
  });
});
