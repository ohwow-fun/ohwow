import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessageTokens, ContextBudget, estimateToolTokens } from '../context-budget.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns Math.ceil(length / 4) for non-empty string', () => {
    expect(estimateTokens('hello')).toBe(Math.ceil(5 / 4));
    expect(estimateTokens('hello')).toBe(2);
  });
});

describe('estimateMessageTokens', () => {
  it('adds 4 overhead to string content', () => {
    const msg = { role: 'user', content: 'hello' };
    expect(estimateMessageTokens(msg)).toBe(estimateTokens('hello') + 4);
  });

  it('serializes array content then estimates with 4 overhead', () => {
    const arr = [{ type: 'text', text: 'hi' }];
    const msg = { role: 'user', content: arr };
    expect(estimateMessageTokens(msg)).toBe(estimateTokens(JSON.stringify(arr)) + 4);
  });
});

describe('ContextBudget', () => {
  it('availableForHistory = capacity - system - reserved', () => {
    const budget = new ContextBudget(10000, 2000);
    budget.setSystemPrompt('a'.repeat(400)); // 100 tokens
    expect(budget.availableForHistory).toBe(10000 - 100 - 2000);
  });

  it('availableForHistory floors at 0', () => {
    const budget = new ContextBudget(100, 200);
    budget.setSystemPrompt('a'.repeat(400));
    expect(budget.availableForHistory).toBe(0);
  });

  it('trimToFit returns all messages when they fit', () => {
    const budget = new ContextBudget(100000, 1000);
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const result = budget.trimToFit(messages);
    expect(result).toEqual(messages);
    expect(result.length).toBe(2);
  });

  it('trimToFit removes oldest messages first when over budget', () => {
    const budget = new ContextBudget(200, 50);
    // Each message content is 100 chars = 25 tokens + 4 overhead = 29 tokens each
    // Available = 200 - 0 - 50 = 150
    // 5 messages = 145 tokens, 6 messages = 174 tokens > 150
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: 'user',
      content: `${'x'.repeat(96)}${String(i).padStart(4, '0')}`,
    }));
    const result = budget.trimToFit(messages);
    expect(result.length).toBeLessThan(messages.length);
    // The last message should always be preserved
    expect(result[result.length - 1]).toBe(messages[messages.length - 1]);
  });

  it('trimToFit always keeps at least the last message', () => {
    const budget = new ContextBudget(50, 40);
    // Available = 50 - 0 - 40 = 10 tokens, but message is bigger
    const messages = [
      { role: 'user', content: 'a'.repeat(200) },
      { role: 'user', content: 'b'.repeat(200) },
    ];
    const result = budget.trimToFit(messages);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[result.length - 1]).toBe(messages[messages.length - 1]);
  });

  it('trimToFit updates internal state visible via getState()', () => {
    const budget = new ContextBudget(100000, 1000);
    const messages = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hi there' },
    ];
    budget.trimToFit(messages);
    const state = budget.getState();
    expect(state.messageCount).toBe(2);
    expect(state.historyTokens).toBeGreaterThan(0);
  });

  it('getState() reflects current utilization', () => {
    const budget = new ContextBudget(10000, 2000);
    budget.setSystemPrompt('a'.repeat(400)); // 100 tokens
    const state = budget.getState();
    expect(state.modelCapacity).toBe(10000);
    expect(state.systemPromptTokens).toBe(100);
    expect(state.reservedForResponse).toBe(2000);
    expect(state.availableTokens).toBe(10000 - 100 - 2000);
  });

  it('getState().utilizationPct rounds correctly', () => {
    const budget = new ContextBudget(1000, 333);
    budget.setSystemPrompt('a'.repeat(400)); // 100 tokens
    // used = 100 + 0 + 333 = 433, pct = 433/1000 * 100 = 43.3 → 43
    const state = budget.getState();
    expect(state.utilizationPct).toBe(Math.round((433 / 1000) * 100));
  });

  it('setToolTokens reduces availableForHistory', () => {
    const budget = new ContextBudget(10000, 2000);
    budget.setSystemPrompt('a'.repeat(400)); // 100 tokens
    expect(budget.availableForHistory).toBe(10000 - 100 - 2000);

    budget.setToolTokens(3000);
    expect(budget.availableForHistory).toBe(10000 - 100 - 3000 - 2000);
  });

  it('getState() includes toolTokens in utilization', () => {
    const budget = new ContextBudget(10000, 2000);
    budget.setSystemPrompt('a'.repeat(400)); // 100 tokens
    budget.setToolTokens(500);
    const state = budget.getState();
    expect(state.toolTokens).toBe(500);
    // used = 100 + 500 + 0 + 2000 = 2600
    expect(state.availableTokens).toBe(10000 - 2600);
    expect(state.utilizationPct).toBe(Math.round((2600 / 10000) * 100));
  });

  it('isTight returns true when available history is below threshold', () => {
    const budget = new ContextBudget(5000, 2000);
    budget.setSystemPrompt('a'.repeat(400)); // 100 tokens
    budget.setToolTokens(2500);
    // available = 5000 - 100 - 2500 - 2000 = 400
    expect(budget.isTight(2000)).toBe(true);
    expect(budget.isTight(400)).toBe(false);
  });

  it('trimToFit respects tool token reservation', () => {
    const budget = new ContextBudget(500, 50);
    budget.setToolTokens(300);
    // available = 500 - 0 - 300 - 50 = 150
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'user',
      content: `msg ${i} ${'x'.repeat(40)}`,
    }));
    const result = budget.trimToFit(messages);
    expect(result.length).toBeLessThan(messages.length);
    expect(result[result.length - 1]).toBe(messages[messages.length - 1]);
  });
});

describe('estimateToolTokens', () => {
  it('returns reasonable estimate for sample tools', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'run_agent',
          description: 'Run a specific agent with a task description.',
          parameters: {
            type: 'object',
            properties: {
              agent_id: { type: 'string', description: 'The agent ID' },
              task: { type: 'string', description: 'What the agent should do' },
            },
            required: ['agent_id', 'task'],
          },
        },
      },
    ];
    const tokens = estimateToolTokens(tools);
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(500);
  });

  it('returns 0 for empty array', () => {
    expect(estimateToolTokens([])).toBe(0);
  });

  it('scales with number of tools', () => {
    const makeTool = (name: string) => ({
      type: 'function',
      function: {
        name,
        description: 'A tool that does something useful.',
        parameters: { type: 'object', properties: { x: { type: 'string' } } },
      },
    });
    const one = estimateToolTokens([makeTool('tool1')]);
    const three = estimateToolTokens([makeTool('t1'), makeTool('t2'), makeTool('t3')]);
    expect(three).toBeGreaterThan(one * 2);
  });
});
