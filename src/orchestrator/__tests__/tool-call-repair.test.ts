import { describe, it, expect } from 'vitest';
import { stripMarkdownWrappers, repairJsonStructure, fuzzyMatchToolName, repairToolCall } from '../tool-call-repair.js';
import type { OpenAITool, OpenAIToolCall } from '../../execution/model-router.js';

const sampleTools: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'search_contacts',
      description: 'Search contacts',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'List agents',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_agent',
      description: 'Run an agent',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string' },
          task: { type: 'string' },
          priority: { type: 'boolean' },
        },
        required: ['agent_id', 'task'],
      },
    },
  },
];

function makeToolCall(name: string, args: string): OpenAIToolCall {
  return { id: 'tc_1', type: 'function', function: { name, arguments: args } };
}

describe('stripMarkdownWrappers', () => {
  it('removes ```json wrapper', () => {
    expect(stripMarkdownWrappers('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('removes ``` wrapper without language', () => {
    expect(stripMarkdownWrappers('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('removes stray backticks', () => {
    expect(stripMarkdownWrappers('`{"a": 1}`')).toBe('{"a": 1}');
  });

  it('returns clean JSON unchanged', () => {
    expect(stripMarkdownWrappers('{"a": 1}')).toBe('{"a": 1}');
  });
});

describe('repairJsonStructure', () => {
  it('removes trailing commas', () => {
    expect(JSON.parse(repairJsonStructure('{"a": 1, "b": 2, }'))).toEqual({ a: 1, b: 2 });
  });

  it('converts single quotes when no double quotes present', () => {
    expect(JSON.parse(repairJsonStructure("{'a': 1}"))).toEqual({ a: 1 });
  });

  it('fixes unquoted keys', () => {
    expect(JSON.parse(repairJsonStructure('{name: "test"}'))).toEqual({ name: 'test' });
  });

  it('adds missing closing braces', () => {
    expect(JSON.parse(repairJsonStructure('{"a": {"b": 1}'))).toEqual({ a: { b: 1 } });
  });

  it('adds missing closing brackets', () => {
    expect(JSON.parse(repairJsonStructure('{"a": [1, 2'))).toEqual({ a: [1, 2] });
  });

  it('handles valid JSON unchanged', () => {
    const valid = '{"key": "value", "num": 42}';
    expect(repairJsonStructure(valid)).toBe(valid);
  });
});

describe('fuzzyMatchToolName', () => {
  const names = ['search_contacts', 'list_agents', 'run_agent'];

  it('returns exact match', () => {
    expect(fuzzyMatchToolName('list_agents', names)).toBe('list_agents');
  });

  it('matches singular to plural (prefix match)', () => {
    expect(fuzzyMatchToolName('search_contact', names)).toBe('search_contacts');
  });

  it('matches Levenshtein distance <= 2', () => {
    expect(fuzzyMatchToolName('list_agentz', names)).toBe('list_agents');
  });

  it('returns null for completely wrong names', () => {
    expect(fuzzyMatchToolName('completely_different_thing', names)).toBeNull();
  });
});

describe('repairToolCall', () => {
  it('returns unchanged for valid tool call', () => {
    const tc = makeToolCall('list_agents', '{}');
    const result = repairToolCall(tc, sampleTools);
    expect(result.repaired).toBe(false);
    expect(result.repairs).toEqual([]);
    expect(result.toolCall).toEqual(tc);
  });

  it('repairs markdown-wrapped arguments', () => {
    const tc = makeToolCall('list_agents', '```json\n{}\n```');
    const result = repairToolCall(tc, sampleTools);
    expect(result.repaired).toBe(true);
    expect(result.repairs).toContain('stripped markdown wrapper');
    expect(JSON.parse(result.toolCall.function.arguments)).toEqual({});
  });

  it('repairs trailing commas', () => {
    const tc = makeToolCall('search_contacts', '{"query": "test", }');
    const result = repairToolCall(tc, sampleTools);
    expect(result.repaired).toBe(true);
    expect(JSON.parse(result.toolCall.function.arguments)).toEqual({ query: 'test' });
  });

  it('fuzzy-matches hallucinated tool names', () => {
    const tc = makeToolCall('search_contact', '{"query": "test"}');
    const result = repairToolCall(tc, sampleTools);
    expect(result.repaired).toBe(true);
    expect(result.toolCall.function.name).toBe('search_contacts');
  });

  it('coerces string to number when schema expects number', () => {
    const tc = makeToolCall('search_contacts', '{"query": "test", "limit": "5"}');
    const result = repairToolCall(tc, sampleTools);
    expect(result.repaired).toBe(true);
    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.limit).toBe(5);
  });

  it('coerces string to boolean when schema expects boolean', () => {
    const tc = makeToolCall('run_agent', '{"agent_id": "a1", "task": "do it", "priority": "true"}');
    const result = repairToolCall(tc, sampleTools);
    expect(result.repaired).toBe(true);
    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.priority).toBe(true);
  });

  it('returns error for completely unknown tool', () => {
    const tc = makeToolCall('nonexistent_tool_xyz', '{}');
    const result = repairToolCall(tc, sampleTools);
    expect(result.repaired).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('returns error for unparseable arguments', () => {
    const tc = makeToolCall('list_agents', 'this is not json at all');
    const result = repairToolCall(tc, sampleTools);
    expect(result.repaired).toBe(false);
    expect(result.error).toContain('Could not parse');
  });

  it('handles combined repairs: name + markdown + type coercion', () => {
    const tc = makeToolCall('search_contact', '```json\n{"query": "john", "limit": "10",}\n```');
    const result = repairToolCall(tc, sampleTools);
    expect(result.repaired).toBe(true);
    expect(result.toolCall.function.name).toBe('search_contacts');
    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.query).toBe('john');
    expect(args.limit).toBe(10);
  });
});
