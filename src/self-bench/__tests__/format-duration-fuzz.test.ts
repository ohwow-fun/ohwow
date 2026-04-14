import { describe, it, expect } from 'vitest';
import {
  FormatDurationFuzzExperiment,
  buildCorpus,
  checkOne,
  makeRng,
  parseFormattedDuration,
} from '../experiments/format-duration-fuzz.js';
import type { ExperimentContext } from '../experiment-types.js';

const fakeCtx = {} as ExperimentContext;

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 20; i++) expect(a()).toBe(b());
  });

  it('handles seed 0 without getting stuck', () => {
    const r = makeRng(0);
    const seen = new Set<number>();
    for (let i = 0; i < 10; i++) seen.add(r());
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('buildCorpus', () => {
  it('always includes the fixed edge cases', () => {
    const corpus = buildCorpus(200, 1);
    for (const edge of [0, 1, 999, 1_000, 60_000, 86_400_000]) {
      expect(corpus).toContain(edge);
    }
  });

  it('produces the requested count and only non-negative ints', () => {
    const corpus = buildCorpus(200, 1);
    expect(corpus.length).toBeGreaterThanOrEqual(200);
    for (const v of corpus) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('parseFormattedDuration', () => {
  it('round-trips canonical formatDuration outputs', () => {
    const cases: Array<[string, number]> = [
      ['0ms', 0],
      ['500ms', 500],
      ['1s', 1_000],
      ['1s 500ms', 1_500],
      ['1m', 60_000],
      ['1m 500ms', 60_500],
      ['1h 1m 1s', 3_661_000],
      ['1d', 86_400_000],
      ['2d 2h 2m 3s 456ms', 2 * 86_400_000 + 2 * 3_600_000 + 2 * 60_000 + 3_000 + 456],
    ];
    for (const [input, expected] of cases) {
      expect(parseFormattedDuration(input)).toBe(expected);
    }
  });

  it('rejects out-of-order or malformed token sequences', () => {
    expect(parseFormattedDuration('500ms 1s')).toBeNull(); // wrong order
    expect(parseFormattedDuration('1s 1s')).toBeNull(); // repeated unit
    expect(parseFormattedDuration('1x')).toBeNull(); // bogus unit
    expect(parseFormattedDuration('')).toBeNull();
    expect(parseFormattedDuration('abc')).toBeNull();
  });
});

describe('checkOne', () => {
  it('returns null when the property holds (e.g. integer ms)', () => {
    expect(checkOne(0)).toBeNull();
    expect(checkOne(1500)).toBeNull();
    expect(checkOne(86_400_001)).toBeNull();
  });

  it('flags the throw property for negative input', () => {
    const v = checkOne(-1);
    expect(v?.property).toBe('threw');
  });

  it('treats non-integer input as floor (matches formatDuration contract)', () => {
    expect(checkOne(1500.9)).toBeNull();
  });
});

describe('FormatDurationFuzzExperiment.probe', () => {
  it('returns pass with zero violations on the current implementation', async () => {
    const exp = new FormatDurationFuzzExperiment();
    const r = await exp.probe(fakeCtx);
    const ev = r.evidence as { violations: unknown[]; affected_files: string[] };
    expect(ev.violations).toEqual([]);
    expect(ev.affected_files).toEqual(['src/lib/format-duration.ts']);
    expect(exp.judge(r, [])).toBe('pass');
  });

  it('exposes the target file in the evidence so PatchAuthor can pick it up', async () => {
    const exp = new FormatDurationFuzzExperiment();
    const r = await exp.probe(fakeCtx);
    const ev = r.evidence as { affected_files: string[] };
    expect(ev.affected_files).toContain('src/lib/format-duration.ts');
  });
});
