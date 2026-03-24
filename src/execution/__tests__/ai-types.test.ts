import { describe, it, expect } from 'vitest';
import { calculateCostCents, CLAUDE_TOKEN_COSTS } from '../ai-types.js';

describe('calculateCostCents', () => {
  it('calculates sonnet cost correctly', () => {
    // (1000/1_000_000)*300 + (500/1_000_000)*1500 = 0.0003 + 0.00075 = 0.00105 → ceil = 1? No:
    // Actually: 0.3 + 0.75 = 1.05 → ceil = 2
    // Wait: (1000/1_000_000)*300 = 0.0003 * 1_000_000 / 1_000_000 ... Let me recalculate.
    // inputCost = (1000 / 1_000_000) * 300 = 0.001 * 300 = 0.3
    // outputCost = (500 / 1_000_000) * 1500 = 0.0005 * 1500 = 0.75
    // total = 1.05 → Math.ceil = 2
    const result = calculateCostCents('claude-sonnet-4-5', 1000, 500);
    expect(result).toBe(2);
  });

  it('calculates haiku cost correctly', () => {
    // inputCost = (1000 / 1_000_000) * 100 = 0.1
    // outputCost = (500 / 1_000_000) * 500 = 0.25
    // total = 0.35 → Math.ceil = 1
    const result = calculateCostCents('claude-haiku-4', 1000, 500);
    expect(result).toBe(1);
  });

  it('returns 0 for zero tokens', () => {
    const result = calculateCostCents('claude-sonnet-4-5', 0, 0);
    expect(result).toBe(0);
  });

  it('handles large token counts', () => {
    // inputCost = (1_000_000 / 1_000_000) * 300 = 300
    // outputCost = (500_000 / 1_000_000) * 1500 = 750
    // total = 1050 → Math.ceil = 1050
    const result = calculateCostCents('claude-sonnet-4-5', 1_000_000, 500_000);
    expect(result).toBe(1050);
  });

  it('has cost entries for both models', () => {
    expect(CLAUDE_TOKEN_COSTS['claude-sonnet-4-5']).toBeDefined();
    expect(CLAUDE_TOKEN_COSTS['claude-sonnet-4-5'].input).toBe(300);
    expect(CLAUDE_TOKEN_COSTS['claude-sonnet-4-5'].output).toBe(1500);
    expect(CLAUDE_TOKEN_COSTS['claude-haiku-4']).toBeDefined();
    expect(CLAUDE_TOKEN_COSTS['claude-haiku-4'].input).toBe(100);
    expect(CLAUDE_TOKEN_COSTS['claude-haiku-4'].output).toBe(500);
  });
});
