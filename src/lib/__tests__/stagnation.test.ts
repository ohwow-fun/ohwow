import { describe, it, expect } from 'vitest';
import { hashToolCall, detectStagnation, STAGNATION_PROMPT, REFLECTION_PROMPT } from '../stagnation.js';

describe('hashToolCall', () => {
  it('produces deterministic MD5 hex digest', () => {
    const h1 = hashToolCall('read_file', { path: '/tmp/a.txt' });
    const h2 = hashToolCall('read_file', { path: '/tmp/a.txt' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces different hashes for different tool names', () => {
    const h1 = hashToolCall('read_file', { path: '/tmp/a.txt' });
    const h2 = hashToolCall('write_file', { path: '/tmp/a.txt' });
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = hashToolCall('read_file', { path: '/tmp/a.txt' });
    const h2 = hashToolCall('read_file', { path: '/tmp/b.txt' });
    expect(h1).not.toBe(h2);
  });

  it('is insensitive to input key order', () => {
    // Regression: models emit tool inputs with variable key order — without
    // normalization the stagnation detector could be shuffled around by
    // alternating `{command, working_directory}` and `{working_directory,
    // command}` on otherwise-identical calls.
    const a = hashToolCall('run_bash', {
      command: "sqlite3 runtime.db 'SELECT COUNT(*) FROM llm_calls;'",
      working_directory: '/Users/jesus/.ohwow/workspaces/default',
    });
    const b = hashToolCall('run_bash', {
      working_directory: '/Users/jesus/.ohwow/workspaces/default',
      command: "sqlite3 runtime.db 'SELECT COUNT(*) FROM llm_calls;'",
    });
    expect(a).toBe(b);
  });

  it('normalizes nested object key order', () => {
    const a = hashToolCall('t', { outer: { x: 1, y: 2 }, z: 3 });
    const b = hashToolCall('t', { z: 3, outer: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array order (arrays are sequences, not sets)', () => {
    const a = hashToolCall('t', { items: [1, 2, 3] });
    const b = hashToolCall('t', { items: [3, 2, 1] });
    expect(a).not.toBe(b);
  });
});

describe('detectStagnation', () => {
  it('returns false when fewer hashes than windowSize', () => {
    expect(detectStagnation(['abc', 'abc'])).toBe(false);
  });

  it('returns true when last N hashes are identical', () => {
    expect(detectStagnation(['abc', 'abc', 'abc'])).toBe(true);
  });

  it('returns false when hashes differ within window', () => {
    expect(detectStagnation(['abc', 'def', 'abc'])).toBe(false);
  });

  it('respects custom windowSize parameter', () => {
    const hashes = ['x', 'x', 'x', 'x'];
    expect(detectStagnation(hashes, 4)).toBe(true);
    expect(detectStagnation(hashes, 5)).toBe(false);
  });
});

describe('prompt constants', () => {
  it('STAGNATION_PROMPT is a non-empty string', () => {
    expect(typeof STAGNATION_PROMPT).toBe('string');
    expect(STAGNATION_PROMPT.length).toBeGreaterThan(0);
  });

  it('REFLECTION_PROMPT is a non-empty string', () => {
    expect(typeof REFLECTION_PROMPT).toBe('string');
    expect(REFLECTION_PROMPT.length).toBeGreaterThan(0);
  });
});
