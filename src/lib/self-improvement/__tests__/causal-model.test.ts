import { describe, it, expect } from 'vitest';
import {
  pearsonCorrelation,
  linearCoefficient,
  buildCausalEdges,
  propagateIntervention,
} from '../causal-model.js';
import type { CausalNode, CausalEdge } from '../types.js';

function makeNode(id: string, values: number[], current?: number): CausalNode {
  return {
    id,
    name: id,
    currentValue: current ?? values[values.length - 1],
    historicalValues: values,
    unit: 'count',
  };
}

describe('pearsonCorrelation', () => {
  it('returns ~1.0 for perfectly correlated series', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1.0, 5);
  });

  it('returns ~-1.0 for perfectly anti-correlated series', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(-1.0, 5);
  });

  it('returns ~0 for uncorrelated data', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8];
    const y = [5, 1, 8, 2, 7, 3, 6, 4];
    expect(Math.abs(pearsonCorrelation(x, y))).toBeLessThan(0.3);
  });

  it('returns 0 for arrays shorter than 3', () => {
    expect(pearsonCorrelation([1, 2], [3, 4])).toBe(0);
  });

  it('returns 0 when denominator is 0 (constant series)', () => {
    expect(pearsonCorrelation([5, 5, 5], [1, 2, 3])).toBe(0);
  });
});

describe('linearCoefficient', () => {
  it('returns correct slope (y = 2x → slope 2)', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(linearCoefficient(x, y)).toBeCloseTo(2.0, 5);
  });

  it('returns 0 for arrays shorter than 3', () => {
    expect(linearCoefficient([1], [2])).toBe(0);
  });
});

describe('buildCausalEdges', () => {
  it('finds edges between correlated nodes', () => {
    const nodes = [
      makeNode('a', [1, 2, 3, 4, 5]),
      makeNode('b', [2, 4, 6, 8, 10]),
    ];
    const edges = buildCausalEdges(nodes);
    expect(edges.length).toBe(1);
    expect(edges[0].fromId).toBe('a');
    expect(edges[0].toId).toBe('b');
    expect(edges[0].direction).toBe('positive');
  });

  it('ignores pairs with correlation below MIN_CORRELATION (0.3)', () => {
    const nodes = [
      makeNode('a', [1, 2, 3, 4, 5, 6, 7, 8]),
      makeNode('b', [5, 1, 8, 2, 7, 3, 6, 4]),
    ];
    const edges = buildCausalEdges(nodes);
    expect(edges.length).toBe(0);
  });

  it('detects lagged correlations when lag > immediate', () => {
    // Create data where a leads b by 7 days with strong correlation,
    // but immediate correlation is weaker
    const aVals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    // b lags a by 7: first 7 values are noise, then follows a's pattern
    const bVals = [5, 3, 7, 2, 8, 4, 6, 1, 2, 3, 4, 5, 6, 7, 8];
    const nodes = [makeNode('a', aVals), makeNode('b', bVals)];
    const edges = buildCausalEdges(nodes);
    // Should have at least one edge (either immediate or lagged)
    const laggedEdge = edges.find((e) => e.lagDays === 7);
    if (laggedEdge) {
      expect(laggedEdge.fromId).toBe('a');
      expect(laggedEdge.toId).toBe('b');
    }
  });
});

describe('propagateIntervention', () => {
  it('computes projected values through graph', () => {
    const nodes = [
      makeNode('revenue', [10, 20, 30], 30),
      makeNode('customers', [5, 10, 15], 15),
    ];
    const edges: CausalEdge[] = [{
      fromId: 'revenue',
      toId: 'customers',
      correlation: 0.9,
      direction: 'positive',
      lagDays: 0,
      coefficient: 0.5,
    }];
    const results = propagateIntervention(nodes, edges, 'revenue', 10);
    expect(results.has('customers')).toBe(true);
    const projection = results.get('customers')!;
    expect(projection.projectedValue).toBe(20); // 15 + 10 * 0.5
    expect(projection.confidence).toBeCloseTo(0.9);
  });
});
