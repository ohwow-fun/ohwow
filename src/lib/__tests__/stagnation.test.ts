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
