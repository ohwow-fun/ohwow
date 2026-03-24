import { describe, it, expect } from 'vitest';
import { whatIf, runScenarios } from '../simulator.js';
import type { CausalModelSnapshot, Intervention, CausalNode, CausalEdge } from '../types.js';

function makeSnapshot(
  nodes: CausalNode[],
  edges: CausalEdge[] = [],
): CausalModelSnapshot {
  return { nodes, edges, projections: [], confidence: 1, createdAt: new Date().toISOString() };
}

function makeNode(id: string, current: number): CausalNode {
  return { id, name: id, currentValue: current, historicalValues: [current], unit: 'count' };
}

describe('whatIf', () => {
  it('returns empty projections for unknown node ID', () => {
    const snapshot = makeSnapshot([makeNode('a', 10)]);
    const intervention: Intervention = {
      nodeId: 'unknown',
      changeType: 'absolute',
      changeValue: 5,
      description: 'test',
    };
    const result = whatIf(snapshot, intervention);
    expect(result.projections).toHaveLength(0);
    expect(result.overallConfidence).toBe(0);
  });

  it('handles absolute changeType correctly', () => {
    const snapshot = makeSnapshot(
      [makeNode('a', 100), makeNode('b', 50)],
      [{ fromId: 'a', toId: 'b', correlation: 0.8, direction: 'positive', lagDays: 0, coefficient: 0.5 }],
    );
    const result = whatIf(snapshot, {
      nodeId: 'a', changeType: 'absolute', changeValue: 20, description: 'test',
    });
    // Source projection: 100 + 20 = 120
    const sourceProj = result.projections.find((p) => p.nodeId === 'a');
    expect(sourceProj?.projectedValue).toBe(120);
    // Downstream: 50 + 20*0.5 = 60
    const downstreamProj = result.projections.find((p) => p.nodeId === 'b');
    expect(downstreamProj?.projectedValue).toBe(60);
  });

  it('handles percentage changeType correctly', () => {
    const snapshot = makeSnapshot([makeNode('a', 200)]);
    const result = whatIf(snapshot, {
      nodeId: 'a', changeType: 'percentage', changeValue: 10, description: 'test',
    });
    // 10% of 200 = 20, so projected = 220
    const proj = result.projections.find((p) => p.nodeId === 'a');
    expect(proj?.projectedValue).toBe(220);
  });

  it('source node projection has confidence 1.0', () => {
    const snapshot = makeSnapshot([makeNode('a', 100)]);
    const result = whatIf(snapshot, {
      nodeId: 'a', changeType: 'absolute', changeValue: 10, description: 'test',
    });
    expect(result.projections[0].confidence).toBe(1);
  });

  it('downstream projections have reduced confidence', () => {
    const snapshot = makeSnapshot(
      [makeNode('a', 100), makeNode('b', 50)],
      [{ fromId: 'a', toId: 'b', correlation: 0.8, direction: 'positive', lagDays: 0, coefficient: 1 }],
    );
    const result = whatIf(snapshot, {
      nodeId: 'a', changeType: 'absolute', changeValue: 10, description: 'test',
    });
    const downstream = result.projections.find((p) => p.nodeId === 'b');
    expect(downstream?.confidence).toBeLessThan(1);
    expect(downstream?.confidence).toBe(0.8); // |correlation| * 1 (lagDays=0)
  });
});

describe('runScenarios', () => {
  it('returns one result per intervention', () => {
    const snapshot = makeSnapshot([makeNode('a', 10), makeNode('b', 20)]);
    const interventions: Intervention[] = [
      { nodeId: 'a', changeType: 'absolute', changeValue: 5, description: 'i1' },
      { nodeId: 'b', changeType: 'absolute', changeValue: 3, description: 'i2' },
    ];
    const results = runScenarios(snapshot, interventions);
    expect(results).toHaveLength(2);
  });

  it('overallConfidence is average of all projection confidences', () => {
    const snapshot = makeSnapshot(
      [makeNode('a', 100), makeNode('b', 50)],
      [{ fromId: 'a', toId: 'b', correlation: 0.8, direction: 'positive', lagDays: 0, coefficient: 1 }],
    );
    const [result] = runScenarios(snapshot, [
      { nodeId: 'a', changeType: 'absolute', changeValue: 10, description: 'test' },
    ]);
    // Source confidence = 1.0, downstream = 0.8 → avg = 0.9
    expect(result.overallConfidence).toBeCloseTo(0.9);
  });
});
