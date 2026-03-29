import { describe, it, expect } from 'vitest';
import { buildReflectionPrompt } from '../reflection.js';
import type { ToolResult } from '../local-tool-types.js';

function makeToolMap(entries: [string, boolean][]): Map<string, ToolResult> {
  const map = new Map<string, ToolResult>();
  for (const [key, success] of entries) {
    map.set(key, { success });
  }
  return map;
}

describe('buildReflectionPrompt', () => {
  it('returns "no tools called" message when executedToolCalls is empty', () => {
    const result = buildReflectionPrompt('Do something', new Map(), 0, 10);
    expect(result).toContain('No tools called yet');
  });

  it('includes tool summary with OK/FAILED status per tool', () => {
    const tools = makeToolMap([
      ['list_agents:1', true],
      ['run_agent:2', false],
    ]);
    const result = buildReflectionPrompt('task', tools, 1, 10);
    expect(result).toContain('list_agents: OK');
    expect(result).toContain('run_agent: FAILED');
  });

  it('truncates user message after first iteration (> 200 chars)', () => {
    const longMsg = 'A'.repeat(300);
    const result = buildReflectionPrompt(longMsg, makeToolMap([['foo:1', true]]), 1, 10);
    expect(result).toContain('A'.repeat(200) + '...');
    expect(result).not.toContain('A'.repeat(201));
  });

  it('does not truncate user message on iteration 0', () => {
    const longMsg = 'B'.repeat(300);
    const result = buildReflectionPrompt(longMsg, makeToolMap([['foo:1', true]]), 0, 10);
    expect(result).toContain('B'.repeat(300));
  });

  it('caps tool summary at 10 lines and shows "and N more tools"', () => {
    const entries: [string, boolean][] = [];
    for (let i = 0; i < 15; i++) {
      entries.push([`tool_${i}:${i}`, true]);
    }
    const result = buildReflectionPrompt('task', makeToolMap(entries), 0, 20);
    expect(result).toContain('and 6 more tools');
  });

  it('includes iteration warning when near max iterations', () => {
    const tools = makeToolMap([['foo:1', true]]);
    const result = buildReflectionPrompt('task', tools, 8, 10);
    expect(result).toContain('near the iteration limit');
    expect(result).toContain('9/10');
  });

  it('does not include iteration warning when far from limit', () => {
    const tools = makeToolMap([['foo:1', true]]);
    const result = buildReflectionPrompt('task', tools, 2, 10);
    expect(result).not.toContain('iteration limit');
  });

  it('includes original task text in output', () => {
    const result = buildReflectionPrompt('Summarize Q3 revenue', makeToolMap([['foo:1', true]]), 0, 10);
    expect(result).toContain('Summarize Q3 revenue');
  });
});
