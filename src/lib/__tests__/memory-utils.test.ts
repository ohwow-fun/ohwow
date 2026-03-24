import { describe, it, expect } from 'vitest';
import {
  normalizeMemory,
  hashMemory,
  jaccardSimilarity,
  isJunkMemory,
  checkDedup,
} from '../memory-utils.js';

describe('normalizeMemory', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeMemory('  Hello   World  ')).toBe('hello world');
    expect(normalizeMemory('\tFoo\n\nBar  Baz\t')).toBe('foo bar baz');
  });

  it('returns already normalized content unchanged', () => {
    expect(normalizeMemory('hello world')).toBe('hello world');
  });
});

describe('hashMemory', () => {
  it('returns an 8-character hex string', () => {
    const hash = hashMemory('some content');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces the same hash for equivalent normalized content', () => {
    const hash1 = hashMemory('Hello  World');
    const hash2 = hashMemory('hello world');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different content', () => {
    const hash1 = hashMemory('hello world');
    const hash2 = hashMemory('goodbye world');
    expect(hash1).not.toBe(hash2);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical meaningful strings', () => {
    expect(jaccardSimilarity('the quick brown fox', 'the quick brown fox')).toBe(1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    expect(jaccardSimilarity('apple banana cherry', 'xenon yttrium zirconium')).toBe(0.0);
  });

  it('returns a value between 0 and 1 for partially overlapping strings', () => {
    const sim = jaccardSimilarity('quick brown fox jumps', 'quick red fox leaps');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('returns 1.0 for two empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(1.0);
  });

  it('returns 0.0 when one string is empty and the other is not', () => {
    expect(jaccardSimilarity('', 'hello world test')).toBe(0.0);
    expect(jaccardSimilarity('hello world test', '')).toBe(0.0);
  });
});

describe('isJunkMemory', () => {
  it('rejects short content (< 10 chars)', () => {
    expect(isJunkMemory('too short')).toBe(true);
    expect(isJunkMemory('hi')).toBe(true);
  });

  it('rejects long content (> 500 chars)', () => {
    const longContent = 'a'.repeat(501);
    expect(isJunkMemory(longContent)).toBe(true);
  });

  it('rejects API keys (sk-...)', () => {
    expect(isJunkMemory('my key is sk-abc123def456ghi789jklmno')).toBe(true);
  });

  it('rejects system prompt fragments', () => {
    expect(isJunkMemory('You are an AI assistant that helps users')).toBe(true);
    expect(isJunkMemory('As an AI language model, I cannot help')).toBe(true);
    expect(isJunkMemory("I'm an AI chatbot designed to assist you")).toBe(true);
  });

  it('rejects bare URLs', () => {
    expect(isJunkMemory('https://example.com/some/path')).toBe(true);
    expect(isJunkMemory('/api/v1/endpoint')).toBe(true);
  });

  it('rejects JSON blobs', () => {
    expect(isJunkMemory('{"key": "value", "nested": {"a": 1}}')).toBe(true);
    expect(isJunkMemory('[{"id": 1}, {"id": 2}]')).toBe(true);
  });

  it('accepts normal memory content', () => {
    expect(isJunkMemory('The user prefers dark mode in the dashboard')).toBe(false);
    expect(isJunkMemory('Project uses React with TypeScript and Tailwind CSS')).toBe(false);
  });

  it('rejects password patterns', () => {
    expect(isJunkMemory('the database password: supersecret123')).toBe(true);
    expect(isJunkMemory('secret=my_secret_value_here_1234')).toBe(true);
  });

  it('rejects Bearer tokens', () => {
    expect(isJunkMemory('use Bearer eyJhbGciOiJIUzI1NiIsInR5c for auth')).toBe(true);
  });
});

describe('checkDedup', () => {
  it('returns insert for new unique content', () => {
    const existing = [
      { id: '1', content: 'The user likes dark mode' },
      { id: '2', content: 'Project uses TypeScript' },
    ];
    const result = checkDedup('Deployment runs on Vercel', existing);
    expect(result).toEqual({ action: 'insert' });
  });

  it('returns skip for exact normalized match', () => {
    const existing = [
      { id: '1', content: 'The user likes dark mode' },
      { id: '2', content: 'Project uses TypeScript' },
    ];
    const result = checkDedup('  The  User  Likes  Dark  Mode  ', existing);
    expect(result).toEqual({ action: 'skip', existingId: '1' });
  });

  it('returns update_existing for high similarity', () => {
    const a = 'deploy production server restart nginx reload config backend monitoring dashboard staging pipeline cluster';
    const b = 'deploy production server restart nginx reload settings backend monitoring dashboard staging pipeline cluster';
    // Verify the similarity is above threshold before testing checkDedup
    const similarity = jaccardSimilarity(a, b);
    expect(similarity).toBeGreaterThanOrEqual(0.85);
    const existing = [{ id: '1', content: a }];
    const result = checkDedup(b, existing);
    expect(result.action).toBe('update_existing');
    expect(result.existingId).toBe('1');
  });

  it('returns insert for low similarity content', () => {
    const existing = [
      { id: '1', content: 'The user prefers dark mode in settings' },
    ];
    const result = checkDedup('Deployment pipeline uses GitHub Actions with Docker', existing);
    expect(result).toEqual({ action: 'insert' });
  });

  it('returns insert for empty existing memories array', () => {
    const result = checkDedup('Some brand new memory content here', []);
    expect(result).toEqual({ action: 'insert' });
  });
});
