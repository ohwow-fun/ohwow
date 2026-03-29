import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  // Must be a real function (not arrow) to be constructable with `new`
  function MockAnthropic() {
    return { messages: { create: mockCreate } };
  }
  return { default: MockAnthropic };
});

import { verifyAgentOutputLocal } from '../verifier.js';

describe('verifyAgentOutputLocal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips short outputs (returns null)', async () => {
    const result = await verifyAgentOutputLocal('task', 'short', [], {
      anthropicApiKey: 'test',
    });
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips T1 tier tasks (returns null)', async () => {
    const result = await verifyAgentOutputLocal('task', 'x'.repeat(200), [], {
      anthropicApiKey: 'test',
      tierIsT1: true,
    });
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns pass for score >= 0.8', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"pass": true, "score": 0.95, "issues": []}' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await verifyAgentOutputLocal(
      'Write a summary',
      'x'.repeat(200),
      [{ name: 'list_tasks', success: true }],
      { anthropicApiKey: 'test' },
    );

    expect(result).not.toBeNull();
    expect(result!.pass).toBe(true);
    expect(result!.score).toBe(0.95);
    expect(result!.issues).toHaveLength(0);
  });

  it('returns fail for score < 0.8 with issues', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"pass": false, "score": 0.4, "issues": [{"type": "factual", "detail": "Incorrect data referenced"}]}' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await verifyAgentOutputLocal(
      'Write a summary',
      'x'.repeat(200),
      [],
      { anthropicApiKey: 'test' },
    );

    expect(result).not.toBeNull();
    expect(result!.pass).toBe(false);
    expect(result!.score).toBe(0.4);
    expect(result!.issues).toHaveLength(1);
    expect(result!.issues[0].type).toBe('factual');
  });

  it('handles malformed AI response gracefully (returns null)', async () => {
    mockCreate.mockRejectedValue(new Error('API error'));

    const result = await verifyAgentOutputLocal(
      'task',
      'x'.repeat(200),
      [],
      { anthropicApiKey: 'test' },
    );

    expect(result).toBeNull();
  });

  it('includes token and cost accounting', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"pass": true, "score": 0.9, "issues": []}' }],
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    const result = await verifyAgentOutputLocal(
      'task',
      'x'.repeat(200),
      [],
      { anthropicApiKey: 'test' },
    );

    expect(result).not.toBeNull();
    expect(result!.tokensUsed).toBe(300);
    expect(result!.costCents).toBeGreaterThanOrEqual(0);
  });
});
