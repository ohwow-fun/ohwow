import { describe, it, expect } from 'vitest';
import { parseToolArguments } from '../tool-parse.js';

describe('parseToolArguments', () => {
  it('returns parsed args for valid JSON object', () => {
    const result = parseToolArguments('{"key":"value","count":42}', 'myTool');
    expect(result).toEqual({ args: { key: 'value', count: 42 } });
    expect(result.error).toBeUndefined();
  });

  it('returns empty object with no error for undefined input', () => {
    const result = parseToolArguments(undefined, 'myTool');
    expect(result).toEqual({ args: {} });
    expect(result.error).toBeUndefined();
  });

  it('returns empty object with no error for empty string input', () => {
    const result = parseToolArguments('', 'myTool');
    expect(result).toEqual({ args: {} });
    expect(result.error).toBeUndefined();
  });

  it('returns error with preview for malformed JSON', () => {
    const result = parseToolArguments('{not valid json}', 'myTool');
    expect(result.args).toEqual({});
    expect(result.error).toContain('Tool "myTool"');
    expect(result.error).toContain('malformed JSON arguments');
    expect(result.error).toContain('{not valid json}');
  });

  it('returns error for JSON array input', () => {
    const result = parseToolArguments('[1, 2, 3]', 'arrayTool');
    expect(result.args).toEqual({});
    expect(result.error).toBe('Tool "arrayTool": arguments must be a JSON object, got array');
  });

  it('returns error for JSON number input', () => {
    const result = parseToolArguments('42', 'numTool');
    expect(result.args).toEqual({});
    expect(result.error).toBe('Tool "numTool": arguments must be a JSON object, got number');
  });

  it('returns error for JSON string input', () => {
    const result = parseToolArguments('"hello"', 'strTool');
    expect(result.args).toEqual({});
    expect(result.error).toBe('Tool "strTool": arguments must be a JSON object, got string');
  });

  it('returns error for JSON boolean input', () => {
    const result = parseToolArguments('true', 'boolTool');
    expect(result.args).toEqual({});
    expect(result.error).toBe('Tool "boolTool": arguments must be a JSON object, got boolean');
  });

  it('returns error for JSON null input', () => {
    const result = parseToolArguments('null', 'nullTool');
    expect(result.args).toEqual({});
    expect(result.error).toBe('Tool "nullTool": arguments must be a JSON object, got object');
  });

  it('truncates very long malformed input to 200 chars with ellipsis', () => {
    const longInput = '{' + 'x'.repeat(300);
    const result = parseToolArguments(longInput, 'longTool');
    expect(result.args).toEqual({});
    expect(result.error).toContain('...');
    const preview = result.error!.split('malformed JSON arguments: ')[1];
    expect(preview).toBe(longInput.slice(0, 200) + '...');
  });

  it('does not truncate malformed input that is exactly 200 chars', () => {
    const exactInput = '{' + 'y'.repeat(199);
    expect(exactInput.length).toBe(200);
    const result = parseToolArguments(exactInput, 'exactTool');
    expect(result.args).toEqual({});
    expect(result.error).not.toContain('...');
    expect(result.error).toContain(exactInput);
  });

  it('preserves nested objects correctly', () => {
    const input = JSON.stringify({
      user: { name: 'Alice', settings: { theme: 'dark' } },
      tags: ['a', 'b'],
      count: 5,
    });
    const result = parseToolArguments(input, 'nestedTool');
    expect(result.args).toEqual({
      user: { name: 'Alice', settings: { theme: 'dark' } },
      tags: ['a', 'b'],
      count: 5,
    });
    expect(result.error).toBeUndefined();
  });

  it('includes tool name in error messages', () => {
    const malformed = parseToolArguments('{bad', 'specialTool');
    expect(malformed.error).toContain('Tool "specialTool"');

    const arrayErr = parseToolArguments('[]', 'anotherTool');
    expect(arrayErr.error).toContain('Tool "anotherTool"');
  });

  it('handles unicode in arguments correctly', () => {
    const input = JSON.stringify({ greeting: 'こんにちは', emoji: '🚀', accent: 'café' });
    const result = parseToolArguments(input, 'unicodeTool');
    expect(result.args).toEqual({ greeting: 'こんにちは', emoji: '🚀', accent: 'café' });
    expect(result.error).toBeUndefined();
  });
});
