/**
 * Tests for sentence chunking logic
 */

import { describe, it, expect } from 'vitest';
import { splitIntoSentences } from '../voice-session.js';

describe('splitIntoSentences', () => {
  it('splits on periods', () => {
    const result = splitIntoSentences('Hello there. How are you? I am fine!');
    expect(result).toEqual(['Hello there.', 'How are you?', 'I am fine!']);
  });

  it('returns single sentence when no boundaries', () => {
    const result = splitIntoSentences('Hello there, how are you');
    expect(result).toEqual(['Hello there, how are you']);
  });

  it('returns empty array for empty input', () => {
    expect(splitIntoSentences('')).toEqual([]);
    expect(splitIntoSentences('   ')).toEqual([]);
  });

  it('merges very short fragments with previous sentence', () => {
    // "Ok." is < 10 chars, should merge with previous
    const result = splitIntoSentences('I understand that. Ok.');
    expect(result).toEqual(['I understand that. Ok.']);
  });

  it('handles multiple sentence types', () => {
    const result = splitIntoSentences('Great! What do you think? Let me know.');
    expect(result).toEqual(['Great!', 'What do you think?', 'Let me know.']);
  });

  it('handles single sentence with trailing punctuation', () => {
    const result = splitIntoSentences('Just one sentence.');
    expect(result).toEqual(['Just one sentence.']);
  });

  it('trims whitespace', () => {
    const result = splitIntoSentences('  First sentence.   Second sentence.  ');
    expect(result).toEqual(['First sentence.', 'Second sentence.']);
  });

  it('handles sentence without ending punctuation', () => {
    const result = splitIntoSentences('First sentence. Second without period');
    expect(result).toEqual(['First sentence.', 'Second without period']);
  });
});
