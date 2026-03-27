import { describe, it, expect } from 'vitest';
import { convertToolsToOpenAI, compressToolsForContext } from '../tool-format.js';

describe('convertToolsToOpenAI', () => {
  it('converts a single tool correctly', () => {
    const tools = [
      {
        name: 'get_weather',
        description: 'Get the current weather',
        input_schema: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    ] as any;

    const result = convertToolsToOpenAI(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the current weather',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    });
  });

  it('defaults description to empty string when missing', () => {
    const tools = [
      {
        name: 'no_desc_tool',
        description: undefined,
        input_schema: { type: 'object', properties: {} },
      },
    ] as any;

    const result = convertToolsToOpenAI(tools);

    expect(result[0].function.description).toBe('');
  });

  it('returns empty array for empty tool list', () => {
    const result = convertToolsToOpenAI([]);
    expect(result).toEqual([]);
  });

  it('handles tool with nested schema properties', () => {
    const tools = [
      {
        name: 'create_record',
        description: 'Create a new record',
        input_schema: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    ] as any;

    const result = convertToolsToOpenAI(tools);

    expect(result[0].function.parameters).toEqual({
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    });
  });

  it('preserves all tool properties in conversion', () => {
    const tools = [
      {
        name: 'tool_a',
        description: 'First tool',
        input_schema: { type: 'object', properties: { x: { type: 'number' } } },
      },
      {
        name: 'tool_b',
        description: 'Second tool',
        input_schema: { type: 'object', properties: { y: { type: 'string' } } },
      },
    ] as any;

    const result = convertToolsToOpenAI(tools);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('function');
    expect(result[0].function.name).toBe('tool_a');
    expect(result[1].type).toBe('function');
    expect(result[1].function.name).toBe('tool_b');
    expect(result[0].function.parameters).toEqual({
      type: 'object',
      properties: { x: { type: 'number' } },
    });
    expect(result[1].function.parameters).toEqual({
      type: 'object',
      properties: { y: { type: 'string' } },
    });
  });
});

describe('compressToolsForContext', () => {
  it('shortens descriptions to first sentence', () => {
    const tools = [{
      type: 'function' as const,
      function: {
        name: 'run_agent',
        description: 'Run a specific agent with a task. Always confirm before running. Use queue_task for non-urgent work.',
        parameters: { type: 'object', properties: {} },
      },
    }];
    const result = compressToolsForContext(tools);
    expect(result[0].function.description).toBe('Run a specific agent with a task.');
  });

  it('caps long first sentences at 120 chars', () => {
    const longSentence = 'A'.repeat(200);
    const tools = [{
      type: 'function' as const,
      function: {
        name: 'test',
        description: longSentence,
        parameters: { type: 'object', properties: {} },
      },
    }];
    const result = compressToolsForContext(tools);
    expect(result[0].function.description.length).toBeLessThanOrEqual(120);
    expect(result[0].function.description.endsWith('...')).toBe(true);
  });

  it('strips parameter descriptions but keeps types and required', () => {
    const tools = [{
      type: 'function' as const,
      function: {
        name: 'search',
        description: 'Search for items.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query to use' },
            limit: { type: 'number', description: 'Max results to return' },
          },
          required: ['query'],
        },
      },
    }];
    const result = compressToolsForContext(tools);
    const params = result[0].function.parameters;
    expect(params.required).toEqual(['query']);
    expect((params.properties as Record<string, Record<string, unknown>>).query.type).toBe('string');
    expect((params.properties as Record<string, Record<string, unknown>>).query.description).toBeUndefined();
    expect((params.properties as Record<string, Record<string, unknown>>).limit.type).toBe('number');
    expect((params.properties as Record<string, Record<string, unknown>>).limit.description).toBeUndefined();
  });

  it('preserves tool names unchanged', () => {
    const tools = [{
      type: 'function' as const,
      function: {
        name: 'my_special_tool',
        description: 'Does something. With extra details.',
        parameters: { type: 'object', properties: {} },
      },
    }];
    const result = compressToolsForContext(tools);
    expect(result[0].function.name).toBe('my_special_tool');
    expect(result[0].type).toBe('function');
  });

  it('returns empty array for empty input', () => {
    expect(compressToolsForContext([])).toEqual([]);
  });
});
