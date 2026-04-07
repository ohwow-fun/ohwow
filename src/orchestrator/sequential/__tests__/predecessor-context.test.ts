import { describe, it, expect } from 'vitest';
import { buildPredecessorContext, estimatePredecessorTokens } from '../predecessor-context.js';
import type { SequenceStepResult } from '../types.js';

function makeResult(
  overrides: Partial<SequenceStepResult> & { agentId: string }
): SequenceStepResult {
  return {
    stepId: 'step-1',
    status: 'completed',
    wave: 1,
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    ...overrides,
  };
}

describe('buildPredecessorContext', () => {
  const agentNames = new Map([
    ['agent-1', 'Researcher'],
    ['agent-2', 'Writer'],
    ['agent-3', 'Analyst'],
  ]);

  it('returns empty string for no predecessors', () => {
    const result = buildPredecessorContext({
      predecessors: [],
      agentNames,
    });
    expect(result).toBe('');
  });

  it('returns empty string when all predecessors have no output', () => {
    const result = buildPredecessorContext({
      predecessors: [
        makeResult({ agentId: 'agent-1', output: '' }),
        makeResult({ agentId: 'agent-2', output: undefined }),
      ],
      agentNames,
    });
    expect(result).toBe('');
  });

  it('includes output from completed predecessors', () => {
    const result = buildPredecessorContext({
      predecessors: [
        makeResult({ agentId: 'agent-1', output: 'Research findings here' }),
      ],
      agentNames,
    });
    expect(result).toContain('### Researcher');
    expect(result).toContain('Research findings here');
    expect(result).toContain('Prior Work from Your Team');
    expect(result).toContain('Review their work critically');
  });

  it('includes chosen role when available', () => {
    const result = buildPredecessorContext({
      predecessors: [
        makeResult({ agentId: 'agent-1', output: 'Data', chosenRole: 'Data Collector' }),
      ],
      agentNames,
    });
    expect(result).toContain('### Researcher (Data Collector)');
  });

  it('skips failed/abstained predecessors', () => {
    const result = buildPredecessorContext({
      predecessors: [
        makeResult({ agentId: 'agent-1', status: 'failed', output: 'Bad data' }),
        makeResult({ agentId: 'agent-2', status: 'completed', output: 'Good data' }),
        makeResult({ agentId: 'agent-3', status: 'abstained', output: 'Skipped' }),
      ],
      agentNames,
    });
    expect(result).not.toContain('Bad data');
    expect(result).not.toContain('Skipped');
    expect(result).toContain('Good data');
  });

  it('truncates when over budget', () => {
    const longOutput = 'x'.repeat(20_000);
    const result = buildPredecessorContext({
      predecessors: [
        makeResult({ agentId: 'agent-1', output: longOutput }),
      ],
      agentNames,
      charBudget: 1000,
    });
    expect(result.length).toBeLessThan(1200); // budget + framing
    expect(result).toContain('[... truncated for brevity]');
  });

  it('prioritizes recent predecessor when truncating', () => {
    const result = buildPredecessorContext({
      predecessors: [
        makeResult({ stepId: 'old', agentId: 'agent-1', output: 'A'.repeat(5000) }),
        makeResult({ stepId: 'new', agentId: 'agent-2', output: 'B'.repeat(5000) }),
      ],
      agentNames,
      charBudget: 3000,
    });
    // Last predecessor (Writer) should have more content preserved
    const writerContent = result.split('### Writer')[1] || '';
    const researcherContent = result.split('### Researcher')[1]?.split('### Writer')[0] || '';
    expect(writerContent.length).toBeGreaterThan(researcherContent.length);
  });
});

describe('estimatePredecessorTokens', () => {
  it('estimates roughly 4 chars per token', () => {
    const text = 'a'.repeat(400);
    expect(estimatePredecessorTokens(text)).toBe(100);
  });
});
