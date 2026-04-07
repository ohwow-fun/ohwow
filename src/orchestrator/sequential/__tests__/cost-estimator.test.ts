import { describe, it, expect } from 'vitest';
import { estimateSequenceCost, checkSequenceBudget } from '../cost-estimator.js';
import type { SequenceDefinition } from '../types.js';

function makeDefinition(overrides: Partial<SequenceDefinition> = {}): SequenceDefinition {
  return {
    name: 'Test Sequence',
    steps: [
      { id: 'step-1', agentId: 'a1', prompt: 'Research', dependsOn: [], modelTier: 'haiku' },
      { id: 'step-2', agentId: 'a2', prompt: 'Analyze', dependsOn: ['step-1'], modelTier: 'sonnet' },
      { id: 'step-3', agentId: 'a3', prompt: 'Synthesize', dependsOn: ['step-2'], modelTier: 'opus' },
    ],
    ...overrides,
  };
}

describe('estimateSequenceCost', () => {
  it('produces per-step cost estimates', () => {
    const estimate = estimateSequenceCost(makeDefinition());
    expect(estimate.perStep).toHaveLength(3);
    expect(estimate.perStep[0].modelTier).toBe('haiku');
    expect(estimate.perStep[1].modelTier).toBe('sonnet');
    expect(estimate.perStep[2].modelTier).toBe('opus');
  });

  it('haiku steps cost less than sonnet which costs less than opus', () => {
    const estimate = estimateSequenceCost(makeDefinition());
    const haikuCost = estimate.perStep[0].estimatedCostCents;
    const sonnetCost = estimate.perStep[1].estimatedCostCents;
    const opusCost = estimate.perStep[2].estimatedCostCents;
    expect(haikuCost).toBeLessThan(sonnetCost);
    expect(sonnetCost).toBeLessThan(opusCost);
  });

  it('total is sum of all steps plus overhead', () => {
    const estimate = estimateSequenceCost(makeDefinition());
    const stepSum = estimate.perStep.reduce((s, p) => s + p.estimatedCostCents, 0);
    // Total should be step sum + small abstention overhead
    expect(estimate.totalEstimatedCents).toBeGreaterThanOrEqual(stepSum);
  });

  it('optimistic is less than total (assumes ~50% abstention)', () => {
    const estimate = estimateSequenceCost(makeDefinition());
    expect(estimate.optimisticCents).toBeLessThan(estimate.totalEstimatedCents);
  });

  it('defaults to sonnet when no modelTier specified', () => {
    const def = makeDefinition({
      steps: [{ id: 's1', agentId: 'a1', prompt: 'Do stuff', dependsOn: [] }],
    });
    const estimate = estimateSequenceCost(def);
    expect(estimate.perStep[0].modelTier).toBe('sonnet');
  });

  it('returns high confidence for 3 or fewer steps', () => {
    expect(estimateSequenceCost(makeDefinition()).confidence).toBe('high');
  });

  it('returns medium confidence for 4-5 steps', () => {
    const def = makeDefinition({
      steps: [
        { id: 's1', agentId: 'a1', prompt: 'A', dependsOn: [] },
        { id: 's2', agentId: 'a2', prompt: 'B', dependsOn: [] },
        { id: 's3', agentId: 'a3', prompt: 'C', dependsOn: [] },
        { id: 's4', agentId: 'a4', prompt: 'D', dependsOn: [] },
      ],
    });
    expect(estimateSequenceCost(def).confidence).toBe('medium');
  });
});

describe('checkSequenceBudget', () => {
  it('allows when no budget set', () => {
    const estimate = estimateSequenceCost(makeDefinition());
    expect(checkSequenceBudget(estimate, undefined).allowed).toBe(true);
  });

  it('allows when budget exceeds total estimate', () => {
    const estimate = estimateSequenceCost(makeDefinition());
    expect(checkSequenceBudget(estimate, 999999).allowed).toBe(true);
  });

  it('blocks when even optimistic exceeds budget', () => {
    const estimate = estimateSequenceCost(makeDefinition());
    // Use a budget of 1 cent — optimistic for 3 steps (haiku+sonnet+opus) will exceed this
    const result = checkSequenceBudget(estimate, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds budget');
  });

  it('allows when total exceeds but optimistic fits', () => {
    const estimate = estimateSequenceCost(makeDefinition());
    // Set budget between optimistic and total
    const budget = Math.floor((estimate.optimisticCents + estimate.totalEstimatedCents) / 2);
    if (budget > estimate.optimisticCents) {
      expect(checkSequenceBudget(estimate, budget).allowed).toBe(true);
    }
  });
});
