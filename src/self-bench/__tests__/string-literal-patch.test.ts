import { describe, it, expect } from 'vitest';
import {
  parseStringLiteralEditsResponse,
  applyStringLiteralEdits,
} from '../experiments/string-literal-patch.js';

describe('parseStringLiteralEditsResponse', () => {
  it('parses a bare JSON array', () => {
    const r = parseStringLiteralEditsResponse('[{"find":"a","replace":"b"}]');
    expect(Array.isArray(r)).toBe(true);
    if (Array.isArray(r)) expect(r[0]).toEqual({ find: 'a', replace: 'b' });
  });

  it('parses a {edits: [...]} object', () => {
    const r = parseStringLiteralEditsResponse('{"edits":[{"find":"a","replace":"b"}]}');
    expect(Array.isArray(r)).toBe(true);
  });

  it('strips a fenced code block', () => {
    const r = parseStringLiteralEditsResponse('```json\n[{"find":"a","replace":"b"}]\n```');
    expect(Array.isArray(r)).toBe(true);
  });

  it('rejects invalid JSON', () => {
    const r = parseStringLiteralEditsResponse('not json');
    expect(Array.isArray(r)).toBe(false);
  });

  it('rejects no-op edit', () => {
    const r = parseStringLiteralEditsResponse('[{"find":"a","replace":"a"}]');
    expect(Array.isArray(r)).toBe(false);
  });

  it('rejects empty array', () => {
    const r = parseStringLiteralEditsResponse('[]');
    expect(Array.isArray(r)).toBe(false);
  });

  it('rejects missing find/replace', () => {
    expect(Array.isArray(parseStringLiteralEditsResponse('[{"find":"a"}]'))).toBe(false);
    expect(Array.isArray(parseStringLiteralEditsResponse('[{"replace":"b"}]'))).toBe(false);
  });
});

describe('applyStringLiteralEdits', () => {
  it('applies a single unique match', () => {
    const r = applyStringLiteralEdits('hello world', [{ find: 'world', replace: 'friend' }]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('hello friend');
  });

  it('applies multiple left-to-right edits', () => {
    const r = applyStringLiteralEdits('A then B then C', [
      { find: 'A', replace: 'X' },
      { find: 'C', replace: 'Z' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('X then B then Z');
  });

  it('rejects when find not present', () => {
    const r = applyStringLiteralEdits('hello', [{ find: 'nope', replace: 'x' }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  it('rejects ambiguous match without occurrence', () => {
    const r = applyStringLiteralEdits('cat cat', [{ find: 'cat', replace: 'dog' }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/appears 2 times/);
  });

  it('accepts ambiguous match with occurrence', () => {
    const r = applyStringLiteralEdits('cat cat cat', [
      { find: 'cat', replace: 'dog', occurrence: 2 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('cat dog cat');
  });

  it('rejects overlapping edits', () => {
    const r = applyStringLiteralEdits('abcdef', [
      { find: 'abcd', replace: 'X' },
      { find: 'bcde', replace: 'Y' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/overlap/);
  });

  it('rejects occurrence out of range', () => {
    const r = applyStringLiteralEdits('cat cat', [
      { find: 'cat', replace: 'dog', occurrence: 5 },
    ]);
    expect(r.ok).toBe(false);
  });

  it('escapes apostrophe in replacement when surrounding quote is single', () => {
    // Simulates: setError('Something went wrong. Try again?')
    // Replacement "Couldn't load" contains an apostrophe that would break
    // the single-quoted string without escaping.
    const source = `setError('Something went wrong. Try again?')`;
    const r = applyStringLiteralEdits(source, [
      { find: 'Something went wrong. Try again?', replace: "Couldn't load. Try refreshing." },
    ]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe(`setError('Couldn\\'t load. Try refreshing.')`);
  });

  it('does not escape apostrophe when surrounding quote is double', () => {
    const source = `setError("Something went wrong. Try again?")`;
    const r = applyStringLiteralEdits(source, [
      { find: 'Something went wrong. Try again?', replace: "Couldn't load. Try refreshing." },
    ]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe(`setError("Couldn't load. Try refreshing.")`);
  });

  it('does not double-escape already-escaped quotes in replacement', () => {
    const source = `msg('Something wrong')`;
    const r = applyStringLiteralEdits(source, [
      { find: 'Something wrong', replace: "It\\'s broken" },
    ]);
    expect(r.ok).toBe(true);
    // Already-escaped \' must stay as \' — not become \\\'
    expect(r.content).toBe(`msg('It\\'s broken')`);
  });
});
