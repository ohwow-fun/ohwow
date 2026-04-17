import { describe, it, expect } from 'vitest';
import { buildPostProbe } from '../social-cdp-helpers.js';

describe('buildPostProbe', () => {
  it('returns the first six words when under the 60-char budget', () => {
    expect(buildPostProbe('The quick brown fox jumps over the lazy dog'))
      .toBe('The quick brown fox jumps over');
  });

  it('stops at the character budget when a single long word exceeds 60 chars', () => {
    const text = 'supercalifragilisticexpialidocious_is_a_very_long_single_token_that_exceeds_limits and more';
    const probe = buildPostProbe(text);
    expect(probe.length).toBeLessThanOrEqual(60);
    // The first token exceeds 60 chars so the probe is empty — callers
    // treat that as probe_error rather than misusing a truncated token
    // that would never match the rendered DOM exactly.
    expect(probe).toBe('');
  });

  it('returns only the first line when the text spans multiple', () => {
    expect(buildPostProbe('Opening line is the hook\n\nSecond paragraph elaborates.'))
      .toBe('Opening line is the hook');
  });

  it('handles leading/trailing whitespace', () => {
    expect(buildPostProbe('   hello world   ')).toBe('hello world');
  });

  it('returns empty for whitespace-only text', () => {
    expect(buildPostProbe('    \n  ')).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(buildPostProbe('')).toBe('');
  });

  it('collapses runs of whitespace between tokens within the first line', () => {
    // Only the first line is considered: newlines in tweets are
    // preserved verbatim in the DOM, so crossing a \n would break the
    // includes() match in the rendered article.
    expect(buildPostProbe('one    two\tthree\n\nfour five six seven'))
      .toBe('one two three');
  });

  it('preserves punctuation inside the probe', () => {
    // Punctuation stays because the rendered tweet DOM preserves it;
    // stripping it here would break the .includes() match on the probe.
    expect(buildPostProbe('Hey, everyone! Check this out now.'))
      .toBe('Hey, everyone! Check this out now.');
  });

  it('truncates to fit the 60-char budget when the sixth word would overflow', () => {
    const text = 'one two three four five sixxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const probe = buildPostProbe(text);
    expect(probe.length).toBeLessThanOrEqual(60);
    expect(probe).toBe('one two three four five');
  });
});
