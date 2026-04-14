import { describe, it, expect } from 'vitest';
import { normalizeMessage, tokenSimilarity, extractKeywords, matchesTriggers } from '../token-similarity.js';

describe('normalizeMessage', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeMessage('  Hello,   World!  ')).toBe('hello world');
  });

  it('returns empty string for an empty input', () => {
    expect(normalizeMessage('')).toBe('');
  });

  it('handles a string of only punctuation', () => {
    expect(normalizeMessage('!!!???...')).toBe('');
  });
});

describe('tokenSimilarity', () => {
  it('returns 1.0 for identical messages', () => {
    expect(tokenSimilarity('the quick brown fox', 'the quick brown fox')).toBe(1);
  });

  it('returns 0 when there are no shared tokens', () => {
    expect(tokenSimilarity('apple banana', 'car dog')).toBe(0);
  });

  it('returns 0 when one input is empty', () => {
    expect(tokenSimilarity('something', '')).toBe(0);
  });

  it('computes correct Jaccard for partial overlap', () => {
    // tokens: {a, b, c} vs {b, c, d} => intersection=2, union=4 => 0.5
    expect(tokenSimilarity('a b c', 'b c d')).toBe(0.5);
  });
});

describe('extractKeywords', () => {
  it('extracts words longer than 3 characters', () => {
    expect(extractKeywords('the quick brown fox jumps')).toEqual(['quick', 'brown', 'jumps']);
  });

  it('respects the limit parameter', () => {
    const keywords = extractKeywords('one two three four five six seven', 2);
    expect(keywords).toHaveLength(2);
    expect(keywords).toEqual(['three', 'four']);
  });

  it('returns empty array when all words are short', () => {
    expect(extractKeywords('a an it is')).toEqual([]);
  });
});

describe('matchesTriggers', () => {
  it('returns true when a keyword matches a trigger', () => {
    expect(matchesTriggers(['deploy', 'rollback'], ['deploy', 'now'])).toBe(true);
  });

  it('returns false when no keyword matches', () => {
    expect(matchesTriggers(['deploy', 'rollback'], ['launch', 'ship'])).toBe(false);
  });

  it('returns false when triggers list is empty', () => {
    expect(matchesTriggers([], ['anything'])).toBe(false);
  });

  it('returns false when keywords list is empty', () => {
    expect(matchesTriggers(['deploy'], [])).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(matchesTriggers(['DEPLOY'], ['deploy'])).toBe(true);
  });
});
