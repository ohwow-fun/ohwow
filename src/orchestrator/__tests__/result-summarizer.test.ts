import { describe, it, expect } from 'vitest';
import { summarizeToolResult } from '../result-summarizer.js';

describe('summarizeToolResult', () => {
  it('passes through content under budget unchanged', () => {
    const short = 'Hello world';
    expect(summarizeToolResult('list_agents', short, false)).toBe(short);
  });

  it('passes through error results unchanged regardless of length', () => {
    const longError = 'x'.repeat(10000);
    expect(summarizeToolResult('list_agents', longError, true)).toBe(longError);
  });

  it('never truncates tools in NEVER_TRUNCATE set', () => {
    const longContent = 'x'.repeat(10000);
    expect(summarizeToolResult('update_plan', longContent, false)).toBe(longContent);
    expect(summarizeToolResult('approve_task', longContent, false)).toBe(longContent);
  });

  it('uses per-tool max chars from TOOL_MAX_CHARS', () => {
    // list_agents has a 2000 char limit
    const longContent = Array.from({ length: 100 }, () => 'line content here').join('\n');
    const result = summarizeToolResult('list_agents', longContent, false);
    expect(result.length).toBeLessThanOrEqual(2100); // some slack for suffix
  });

  it('falls back to DEFAULT_MAX_CHARS (5000) for unknown tools', () => {
    const longContent = 'x\n'.repeat(6000);
    const result = summarizeToolResult('unknown_custom_tool', longContent, false);
    expect(result.length).toBeLessThanOrEqual(5100);
  });

  it('truncates JSON arrays with binary search, appending count suffix', () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Agent ${i}`, description: 'A long description field' }));
    const json = JSON.stringify(arr);
    const result = summarizeToolResult('list_agents', json, false);
    expect(result.length).toBeLessThanOrEqual(2100);
    expect(result).toContain('more items');
    expect(result).toContain('100 total');
  });

  it('falls back to text truncation when single JSON array item exceeds max', () => {
    const arr = [{ content: 'x'.repeat(5000) }];
    const json = JSON.stringify(arr);
    const result = summarizeToolResult('list_agents', json, false);
    // Should fall back to truncateText since even 1 item exceeds 2000
    expect(result.length).toBeLessThanOrEqual(2100);
    expect(result).toContain('truncated');
  });

  it('handles invalid JSON gracefully by falling back to text truncation', () => {
    const notJson = '[invalid json' + 'x'.repeat(5000);
    const result = summarizeToolResult('list_agents', notJson, false);
    expect(result.length).toBeLessThanOrEqual(2100);
    expect(result).toContain('truncated');
  });

  it('truncates plain text preserving whole lines with remaining count', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: some content here that makes the line longer`);
    const text = lines.join('\n');
    const result = summarizeToolResult('list_agents', text, false);
    expect(result.length).toBeLessThanOrEqual(2100);
    expect(result).toContain('more lines');
  });

  it('truncates JSON objects with char count suffix', () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 100; i++) obj[`key_${i}`] = 'x'.repeat(50);
    const json = JSON.stringify(obj);
    const result = summarizeToolResult('list_agents', json, false);
    expect(result.length).toBeLessThanOrEqual(2100);
    expect(result).toContain('truncated');
  });
});
