import { describe, it, expect } from 'vitest';
import { chunkText, extractKeywords } from '../chunker.js';

describe('chunkText', () => {
  it('returns empty array for empty/whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
    expect(chunkText('\n\n')).toEqual([]);
  });

  it('returns single chunk for small text', () => {
    const text = 'Hello world, this is a short document.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
    expect(chunks[0].overlapPrefix).toBeUndefined();
  });

  it('returns single chunk when text is within 1.2x target', () => {
    const text = 'a'.repeat(4500); // 4500 < 4000 * 1.2 = 4800
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
  });

  it('chunks long text without headers by paragraph size', () => {
    // Build text that exceeds targetChars
    const paragraph = 'Lorem ipsum dolor sit amet. '.repeat(50); // ~1400 chars
    const text = [paragraph, paragraph, paragraph, paragraph].join('\n\n'); // ~5600 chars + separators
    const chunks = chunkText(text, { targetChars: 2000, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  it('preserves markdown header context in headerPrefix', () => {
    const text = [
      '# Introduction',
      'Some intro text that is long enough.',
      '',
      '## API Reference',
      'API overview text.',
      '',
      '### Authentication',
      'Auth details here.',
    ].join('\n');

    // Use small target so we get multiple chunks from headers alone
    // But the whole text is small, so use a very small target
    const chunks = chunkText(text, { targetChars: 30, overlapChars: 0 });

    // Find a chunk that has a nested header prefix
    const authChunk = chunks.find((c) => c.content.includes('Auth details'));
    expect(authChunk).toBeDefined();
    expect(authChunk!.headerPrefix).toContain('# Introduction');
    expect(authChunk!.headerPrefix).toContain('## API Reference');
    expect(authChunk!.headerPrefix).toContain('### Authentication');
  });

  it('never splits inside a fenced code block', () => {
    const codeBlock = [
      '```typescript',
      'function hello() {',
      '  return "world";',
      '}',
      '```',
    ].join('\n');

    const text = [
      '# Section',
      'Some text before.',
      '',
      codeBlock,
      '',
      'Some text after.',
    ].join('\n');

    const chunks = chunkText(text, { targetChars: 50, overlapChars: 0 });

    // The code block should appear intact in exactly one chunk
    const chunksWithCode = chunks.filter((c) => c.content.includes('function hello()'));
    expect(chunksWithCode).toHaveLength(1);
    expect(chunksWithCode[0].content).toContain('```typescript');
    expect(chunksWithCode[0].content).toContain('```');
    expect(chunksWithCode[0].content).toContain('return "world"');
  });

  it('generates overlap between consecutive chunks', () => {
    const para1 = 'Alpha bravo charlie delta echo foxtrot. '.repeat(40);
    const para2 = 'Golf hotel india juliet kilo lima. '.repeat(40);
    const text = para1 + '\n\n' + para2;

    const chunks = chunkText(text, { targetChars: 1500, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);

    // Second chunk should have overlap from first
    const second = chunks[1];
    expect(second.overlapPrefix).toBeDefined();
    expect(second.overlapPrefix!.length).toBeGreaterThan(0);
    expect(second.content).toContain('[...]');
  });

  it('first chunk has no overlap', () => {
    // Use paragraph breaks so the chunker can split
    const paragraph = 'Word sentence here. '.repeat(20) + '\n\n';
    const text = paragraph.repeat(20); // many paragraphs
    const chunks = chunkText(text, { targetChars: 500, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].overlapPrefix).toBeUndefined();
  });

  it('extracts keywords per chunk', () => {
    const text = 'authentication token security endpoint api request response. '.repeat(200);
    const chunks = chunkText(text, { targetChars: 1000, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.keywords.length).toBeGreaterThan(0);
      expect(chunk.keywords.length).toBeLessThanOrEqual(5);
    }
  });

  it('respects maxChunks safety limit', () => {
    // Create very long text that would produce many chunks
    const text = ('paragraph text here. '.repeat(50) + '\n\n').repeat(100);
    const chunks = chunkText(text, { targetChars: 200, overlapChars: 0, maxChunks: 5 });
    expect(chunks.length).toBeLessThanOrEqual(5);
  });

  it('handles text with only headers and no body', () => {
    const text = '# Header 1\n## Header 2\n### Header 3';
    const chunks = chunkText(text);
    // Small text, returned as single chunk
    expect(chunks).toHaveLength(1);
  });

  it('handles a code block that exceeds targetChars', () => {
    const bigCode = '```\n' + 'x = 1\n'.repeat(500) + '```';
    const text = 'Intro.\n\n' + bigCode + '\n\nOutro.';
    const chunks = chunkText(text, { targetChars: 200, overlapChars: 0 });
    // The code block should survive intact
    const codeChunk = chunks.find((c) => c.content.includes('x = 1'));
    expect(codeChunk).toBeDefined();
    // It should contain the full code block
    expect(codeChunk!.content).toContain('```');
  });
});

describe('extractKeywords', () => {
  it('returns top keywords by frequency', () => {
    const text = 'api api api endpoint endpoint security token';
    const keywords = extractKeywords(text);
    expect(keywords[0]).toBe('api');
    expect(keywords[1]).toBe('endpoint');
  });

  it('filters stop words', () => {
    const text = 'the and or but authentication is was are';
    const keywords = extractKeywords(text);
    expect(keywords).toContain('authentication');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('and');
  });

  it('returns at most 5 keywords', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india';
    const keywords = extractKeywords(text);
    expect(keywords.length).toBeLessThanOrEqual(5);
  });
});
