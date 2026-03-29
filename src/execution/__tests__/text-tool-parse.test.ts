import { describe, it, expect } from 'vitest';
import { extractToolCallsFromText } from '../text-tool-parse.js';

const knownTools = new Set(['search', 'read_file', 'write_file']);

describe('extractToolCallsFromText', () => {
  // 1. tool_call block with valid JSON extracted
  it('extracts tool_call block with valid JSON {"tool":"search","arguments":{...}}', () => {
    const text = 'Some text\n```tool_call\n{"tool":"search","arguments":{"q":"test"}}\n```\nMore text';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([
      { name: 'search', arguments: { q: 'test' } },
    ]);
    expect(result.cleanedText).toBe('Some text\n\nMore text');
  });

  // 2. tool_call block with tool name on first line, JSON on second
  it('extracts tool_call block with tool name on first line and JSON args on second', () => {
    const text = '```tool_call\nsearch\n{"q":"hello"}\n```';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([
      { name: 'search', arguments: { q: 'hello' } },
    ]);
  });

  // 3. tool_call block with unknown tool name skipped
  it('skips tool_call block when tool name is not in knownToolNames', () => {
    const text = '```tool_call\n{"tool":"unknown_tool","arguments":{"a":1}}\n```';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([]);
    expect(result.cleanedText).toBe(text.trim());
  });

  // 3b. tool_call block with unknown tool name on first line also skipped
  it('skips tool_call block with unknown tool name on first line', () => {
    const text = '```tool_call\nunknown_tool\n{"a":1}\n```';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([]);
  });

  // 4. Generic code block with known tool as language tag
  it('extracts generic code block when language tag is a known tool name', () => {
    const text = '```search\n{"q":"test"}\n```';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([
      { name: 'search', arguments: { q: 'test' } },
    ]);
    expect(result.cleanedText).toBe('');
  });

  // 5. Generic code block with known tool as first line
  it('extracts generic code block when first line is a known tool name', () => {
    const text = '```\nsearch\n{"q":"find me"}\n```';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([
      { name: 'search', arguments: { q: 'find me' } },
    ]);
  });

  // 6. Multiple tool_call blocks extracted in order
  it('extracts multiple tool_call blocks in order', () => {
    const text = [
      '```tool_call',
      '{"tool":"search","arguments":{"q":"first"}}',
      '```',
      'middle text',
      '```tool_call',
      '{"tool":"read_file","arguments":{"path":"/a.txt"}}',
      '```',
    ].join('\n');

    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toEqual({ name: 'search', arguments: { q: 'first' } });
    expect(result.toolCalls[1]).toEqual({ name: 'read_file', arguments: { path: '/a.txt' } });
    expect(result.cleanedText).toBe('middle text');
  });

  // 7. Pass 2 (generic blocks) only runs when pass 1 finds nothing
  it('skips generic code blocks when pass 1 already found tool_call blocks', () => {
    const text = [
      '```tool_call',
      '{"tool":"search","arguments":{"q":"found"}}',
      '```',
      '```read_file',
      '{"path":"/b.txt"}',
      '```',
    ].join('\n');

    const result = extractToolCallsFromText(text, knownTools);

    // Only the tool_call block should be extracted, not the generic block
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('search');
    // The generic block should remain in cleanedText
    expect(result.cleanedText).toContain('```read_file');
  });

  // 8. cleanedText has blocks removed and whitespace trimmed
  it('removes extracted blocks from cleanedText and trims whitespace', () => {
    const text = '  Hello  \n```tool_call\n{"tool":"search","arguments":{}}\n```\n  World  ';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.cleanedText).toBe('Hello  \n\n  World');
  });

  // 9. Malformed JSON in tool_call block falls through to line-based parse
  it('falls back to line-based parsing when JSON is malformed in tool_call block', () => {
    const text = '```tool_call\nsearch\n{not valid json}\n```';
    const result = extractToolCallsFromText(text, knownTools);

    // Should still extract by line-based fallback: first line is tool name
    expect(result.toolCalls).toEqual([
      { name: 'search', arguments: {} },
    ]);
  });

  // 10. Empty code block skipped
  it('skips empty code blocks', () => {
    const text = 'Before\n```tool_call\n```\nAfter';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([]);
  });

  // 11. Tool name with JSON args on same line in generic block (lang tag is tool name, body is JSON)
  it('parses generic block where lang tag is the tool name and body is JSON args', () => {
    const text = '```write_file\n{"path":"/x.ts","content":"hello"}\n```';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([
      { name: 'write_file', arguments: { path: '/x.ts', content: 'hello' } },
    ]);
  });

  // 12. No tool calls returns empty array, original text preserved
  it('returns empty toolCalls and preserves original text when no tools found', () => {
    const text = 'Just some regular text with no code blocks at all.';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([]);
    expect(result.cleanedText).toBe(text);
  });

  // 12b. Code block with non-tool content
  it('returns empty toolCalls when code blocks contain non-tool content', () => {
    const text = '```javascript\nconsole.log("hello")\n```';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([]);
    expect(result.cleanedText).toBe(text.trim());
  });

  // 13. Tool name case sensitivity (exact match required)
  it('requires exact case match for tool names', () => {
    const text = '```tool_call\n{"tool":"Search","arguments":{"q":"test"}}\n```';
    const result = extractToolCallsFromText(text, knownTools);

    // "Search" !== "search", so it should not match
    expect(result.toolCalls).toEqual([]);
  });

  // 13b. Case sensitivity in line-based parse
  it('requires exact case match in line-based tool_call parse', () => {
    const text = '```tool_call\nSEARCH\n{"q":"test"}\n```';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([]);
  });

  // 14. tool_call block with tool name only (no args) produces empty args
  it('extracts tool_call block with tool name only and returns empty arguments', () => {
    const text = '```tool_call\nsearch\n```';
    const result = extractToolCallsFromText(text, knownTools);

    expect(result.toolCalls).toEqual([
      { name: 'search', arguments: {} },
    ]);
  });

  // 15. tryParseToolCallJSON rejects various invalid inputs
  describe('tryParseToolCallJSON rejection cases (via tool_call blocks)', () => {
    it('rejects non-object JSON (array)', () => {
      const text = '```tool_call\n[1,2,3]\n```';
      const result = extractToolCallsFromText(text, knownTools);

      // Array won't have .tool property, so JSON parse path fails
      // Line-based fallback: first line is "[1,2,3]" which is not a known tool
      expect(result.toolCalls).toEqual([]);
    });

    it('rejects null JSON', () => {
      const text = '```tool_call\nnull\n```';
      const result = extractToolCallsFromText(text, knownTools);

      expect(result.toolCalls).toEqual([]);
    });

    it('rejects object missing tool field', () => {
      const text = '```tool_call\n{"name":"search","arguments":{"q":"test"}}\n```';
      const result = extractToolCallsFromText(text, knownTools);

      // No "tool" field, so JSON path rejects it
      // Line-based fallback: first line is the full JSON string, not a known tool name
      expect(result.toolCalls).toEqual([]);
    });

    it('rejects object with unknown tool name', () => {
      const text = '```tool_call\n{"tool":"destroy","arguments":{}}\n```';
      const result = extractToolCallsFromText(text, knownTools);

      expect(result.toolCalls).toEqual([]);
    });

    it('defaults arguments to {} when arguments field is not an object', () => {
      const text = '```tool_call\n{"tool":"search","arguments":"not an object"}\n```';
      const result = extractToolCallsFromText(text, knownTools);

      expect(result.toolCalls).toEqual([
        { name: 'search', arguments: {} },
      ]);
    });

    it('defaults arguments to {} when arguments field is missing', () => {
      const text = '```tool_call\n{"tool":"search"}\n```';
      const result = extractToolCallsFromText(text, knownTools);

      expect(result.toolCalls).toEqual([
        { name: 'search', arguments: {} },
      ]);
    });
  });
});
