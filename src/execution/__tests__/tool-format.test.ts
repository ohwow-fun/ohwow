import { describe, it, expect } from 'vitest';
import { convertToolsToOpenAI } from '../tool-format.js';

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
