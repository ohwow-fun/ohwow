import { describe, it, expect } from 'vitest';
import {
  runTriangulation,
  defaultCompare,
  buildInvestigatePromptForFailure,
  type TriangulationCheck,
  type TriangulationCtx,
} from '../triangulation.js';

// Minimal stub context — most resolvers in these tests don't touch
// it, but the harness type requires the field to exist.
function stubCtx(): TriangulationCtx {
  return {
    toolCtx: {} as TriangulationCtx['toolCtx'],
    sqlite: async () => [],
    readJsonFile: async () => ({}),
    workspaceId: 'ws-test',
  };
}

describe('defaultCompare', () => {
  it('returns true for an empty list', () => {
    expect(defaultCompare([])).toBe(true);
  });
  it('returns true for a single value', () => {
    expect(defaultCompare([42])).toBe(true);
  });
  it('compares primitives', () => {
    expect(defaultCompare([1, 1, 1])).toBe(true);
    expect(defaultCompare([1, 1, 2])).toBe(false);
  });
  it('compares objects deep with key order independence', () => {
    expect(defaultCompare([{ a: 1, b: 2 }, { b: 2, a: 1 }])).toBe(true);
    expect(defaultCompare([{ a: 1, b: 2 }, { b: 2, a: 3 }])).toBe(false);
  });
  it('compares arrays positionally', () => {
    expect(defaultCompare([[1, 2], [1, 2]])).toBe(true);
    expect(defaultCompare([[1, 2], [2, 1]])).toBe(false);
  });
});

describe('runTriangulation', () => {
  it('passes when both resolvers agree', async () => {
    const checks: TriangulationCheck[] = [
      {
        id: 'agreeing',
        description: 'both return 5',
        resolvers: [
          { name: 'a', run: async () => 5 },
          { name: 'b', run: async () => 5 },
        ],
      },
    ];
    const result = await runTriangulation(checks, stubCtx());
    expect(result.passedChecks).toBe(1);
    expect(result.failedChecks).toEqual([]);
    expect(result.results[0].passed).toBe(true);
  });

  it('fails when resolvers disagree and reports both values', async () => {
    const checks: TriangulationCheck[] = [
      {
        id: 'disagreeing',
        description: 'one says 5, the other says 7',
        resolvers: [
          { name: 'list_handler', run: async () => 5 },
          { name: 'sql_count', run: async () => 7 },
        ],
      },
    ];
    const result = await runTriangulation(checks, stubCtx());
    expect(result.passedChecks).toBe(0);
    expect(result.failedChecks).toHaveLength(1);
    expect(result.results[0].passed).toBe(false);
    expect(result.results[0].disagreement).toContain('list_handler=5');
    expect(result.results[0].disagreement).toContain('sql_count=7');
    expect(result.results[0].resolverValues.map((r) => r.value)).toEqual([5, 7]);
  });

  it('treats a resolver throwing as a failure with the error captured', async () => {
    const checks: TriangulationCheck[] = [
      {
        id: 'one_threw',
        description: 'the second resolver blows up',
        resolvers: [
          { name: 'good', run: async () => 5 },
          { name: 'bad', run: async () => { throw new Error('db locked'); } },
        ],
      },
    ];
    const result = await runTriangulation(checks, stubCtx());
    expect(result.results[0].passed).toBe(false);
    const badResult = result.results[0].resolverValues.find((r) => r.name === 'bad');
    expect(badResult?.error).toContain('db locked');
    expect(result.results[0].disagreement).toContain('ERROR(db locked)');
  });

  it('measures latency for each resolver', async () => {
    const checks: TriangulationCheck[] = [
      {
        id: 'latency',
        description: 'resolvers should record their wall time',
        resolvers: [
          { name: 'fast', run: async () => 1 },
          { name: 'slow', run: async () => { await new Promise((r) => setTimeout(r, 20)); return 1; } },
        ],
      },
    ];
    const result = await runTriangulation(checks, stubCtx());
    const latencies = result.results[0].resolverValues.map((r) => r.latencyMs);
    expect(latencies[0]).toBeGreaterThanOrEqual(0);
    expect(latencies[1]).toBeGreaterThanOrEqual(15);
  });

  it('runs every check even when one fails', async () => {
    const checks: TriangulationCheck[] = [
      { id: 'a', description: 'first', resolvers: [{ name: 'x', run: async () => 1 }, { name: 'y', run: async () => 2 }] },
      { id: 'b', description: 'second', resolvers: [{ name: 'x', run: async () => 1 }, { name: 'y', run: async () => 1 }] },
    ];
    const result = await runTriangulation(checks, stubCtx());
    expect(result.totalChecks).toBe(2);
    expect(result.passedChecks).toBe(1);
    expect(result.failedChecks.map((f) => f.checkId)).toEqual(['a']);
  });

  it('honors a custom comparator', async () => {
    const checks: TriangulationCheck[] = [
      {
        id: 'tolerant',
        description: 'allow off-by-one',
        compare: (values) => {
          if (values.length < 2) return true;
          const nums = values.map(Number);
          return Math.abs(nums[0] - nums[1]) <= 1;
        },
        resolvers: [
          { name: 'a', run: async () => 100 },
          { name: 'b', run: async () => 101 },
        ],
      },
    ];
    const result = await runTriangulation(checks, stubCtx());
    expect(result.results[0].passed).toBe(true);
  });
});

describe('buildInvestigatePromptForFailure', () => {
  it('packs the disagreement into a structured prompt the investigator can read', () => {
    const failure = {
      checkId: 'deliverables_since_24h',
      description: 'deliverables created in the last 24h',
      passed: false,
      resolverValues: [
        { name: 'lexicographic_iso_filter', value: 25, latencyMs: 4 },
        { name: 'datetime_normalized_filter', value: 38, latencyMs: 6 },
      ],
      disagreement: 'lexicographic_iso_filter=25 vs datetime_normalized_filter=38',
    };
    const prompt = buildInvestigatePromptForFailure(failure);
    expect(prompt).toContain('deliverables_since_24h');
    expect(prompt).toContain('lexicographic_iso_filter');
    expect(prompt).toContain('datetime_normalized_filter');
    expect(prompt).toContain('25');
    expect(prompt).toContain('38');
    expect(prompt).toContain('Find the ROOT CAUSE');
    expect(prompt).toContain('Do NOT conclude "data drift"');
  });
});
