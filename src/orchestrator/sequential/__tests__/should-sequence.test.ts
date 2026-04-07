import { describe, it, expect } from 'vitest';
import { shouldSequence } from '../should-sequence.js';

const threeAgents = [
  { id: 'a1', name: 'Researcher', role: 'Research & Analysis' },
  { id: 'a2', name: 'Writer', role: 'Content Writer' },
  { id: 'a3', name: 'Analyst', role: 'Data Analyst & Metrics' },
];

describe('shouldSequence', () => {
  it('returns false with only one agent', () => {
    const result = shouldSequence({
      prompt: 'Write a detailed blog post analyzing our Q1 metrics and research industry trends',
      agents: [threeAgents[0]],
    });
    expect(result.shouldSequence).toBe(false);
    expect(result.reason).toContain('Only one agent');
  });

  it('returns false for simple tasks', () => {
    const result = shouldSequence({
      prompt: 'Check the status of my leads',
      agents: threeAgents,
    });
    expect(result.shouldSequence).toBe(false);
  });

  it('returns false for weak local models', () => {
    const result = shouldSequence({
      prompt: 'Research and analyze our competitive landscape, then write a strategy document',
      agents: threeAgents,
      ollamaModel: 'qwen3:8b',
    });
    expect(result.shouldSequence).toBe(false);
    expect(result.reason).toContain('too small');
  });

  it('returns true for multi-domain complex tasks', () => {
    const result = shouldSequence({
      prompt: 'Research our competitors, analyze the data trends, and write a comprehensive blog post about our market position',
      agents: threeAgents,
    });
    expect(result.shouldSequence).toBe(true);
    expect(result.relevantAgentCount).toBeGreaterThanOrEqual(2);
  });

  it('returns true for complex tasks with 3+ agents', () => {
    const result = shouldSequence({
      prompt: 'Create a detailed strategic plan for Q2. First research market conditions, then analyze our metrics and growth trajectory, and finally develop actionable recommendations',
      agents: threeAgents,
    });
    expect(result.shouldSequence).toBe(true);
  });

  it('allows strong local models to self-organize', () => {
    const result = shouldSequence({
      prompt: 'Research and analyze our competitive landscape, then write a strategy document',
      agents: threeAgents,
      ollamaModel: 'qwen3:72b',
    });
    // Should not be blocked by model check
    expect(result.reason).not.toContain('too small');
  });
});
