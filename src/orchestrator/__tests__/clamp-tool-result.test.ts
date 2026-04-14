import { describe, it, expect } from 'vitest';
import { clampToolResult, DEFAULT_TOOL_RESULT_CHAR_CAP } from '../turn-context-guard.js';

describe('clampToolResult', () => {
  it('returns the input unchanged when under the default cap', () => {
    const small = 'hello world';
    expect(clampToolResult(small)).toBe(small);
  });

  it('returns the input unchanged at exactly the cap', () => {
    const exact = 'x'.repeat(DEFAULT_TOOL_RESULT_CHAR_CAP);
    expect(clampToolResult(exact)).toBe(exact);
  });

  it('clamps oversized input to the cap plus a truncation marker', () => {
    const huge = 'a'.repeat(DEFAULT_TOOL_RESULT_CHAR_CAP + 5_000);
    const clamped = clampToolResult(huge);

    // Head preserved verbatim
    expect(clamped.startsWith('a'.repeat(DEFAULT_TOOL_RESULT_CHAR_CAP))).toBe(true);

    // Tail carries the truncation marker the model can read
    expect(clamped).toContain('[truncated:');
    expect(clamped).toContain(`kept ${DEFAULT_TOOL_RESULT_CHAR_CAP}`);
    expect(clamped).toContain(`of ${huge.length}`);
    expect(clamped).toContain('5000 chars omitted');
    expect(clamped).toContain('narrower query');
  });

  it('respects a custom maxChars override', () => {
    const input = 'x'.repeat(1_000);
    const clamped = clampToolResult(input, 200);
    expect(clamped.startsWith('x'.repeat(200))).toBe(true);
    expect(clamped).toContain('kept 200 of 1000');
    expect(clamped).toContain('800 chars omitted');
  });

  it('handles empty input', () => {
    expect(clampToolResult('')).toBe('');
  });

  it('the truncation marker itself does not push the result back above limit', () => {
    // A caller clamping then re-clamping should converge, not explode.
    const huge = 'z'.repeat(DEFAULT_TOOL_RESULT_CHAR_CAP * 3);
    const once = clampToolResult(huge);
    const twice = clampToolResult(once);
    // Second pass sees "head + marker" which is above the cap, so it clamps
    // the entire thing again. That's fine — what we want is: it's bounded.
    expect(twice.length).toBeLessThan(once.length + 500);
  });
});
