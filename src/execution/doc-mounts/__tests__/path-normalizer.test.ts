import { describe, it, expect } from 'vitest';
import {
  normalizeUrlsToPaths,
  detectCommonPrefix,
  urlToNamespace,
  extractDomain,
} from '../path-normalizer.js';

describe('detectCommonPrefix', () => {
  it('finds shared prefix segments', () => {
    const segments = [
      ['docs', 'api', 'charges'],
      ['docs', 'api', 'customers'],
      ['docs', 'api', 'subscriptions'],
    ];
    expect(detectCommonPrefix(segments)).toEqual(['docs', 'api']);
  });

  it('returns empty for no shared prefix', () => {
    const segments = [
      ['api', 'charges'],
      ['guides', 'setup'],
    ];
    expect(detectCommonPrefix(segments)).toEqual([]);
  });

  it('handles single URL', () => {
    const segments = [['docs', 'api', 'charges']];
    // Single URL: strip all but last
    expect(detectCommonPrefix(segments)).toEqual(['docs', 'api']);
  });

  it('handles empty input', () => {
    expect(detectCommonPrefix([])).toEqual([]);
  });
});

describe('normalizeUrlsToPaths', () => {
  it('strips common prefix and adds .md', () => {
    const urls = [
      'https://docs.stripe.com/api/charges/create',
      'https://docs.stripe.com/api/charges/list',
      'https://docs.stripe.com/api/customers/create',
    ];
    const result = normalizeUrlsToPaths(urls, 'https://docs.stripe.com');
    expect(result.get('https://docs.stripe.com/api/charges/create')).toBe('/charges/create.md');
    expect(result.get('https://docs.stripe.com/api/charges/list')).toBe('/charges/list.md');
    expect(result.get('https://docs.stripe.com/api/customers/create')).toBe('/customers/create.md');
  });

  it('handles docs/ prefix sites', () => {
    const urls = [
      'https://better-auth.com/docs/installation',
      'https://better-auth.com/docs/configuration',
      'https://better-auth.com/docs/api/auth',
    ];
    const result = normalizeUrlsToPaths(urls, 'https://better-auth.com');
    expect(result.get('https://better-auth.com/docs/installation')).toBe('/installation.md');
    expect(result.get('https://better-auth.com/docs/configuration')).toBe('/configuration.md');
    expect(result.get('https://better-auth.com/docs/api/auth')).toBe('/api/auth.md');
  });

  it('handles root-level pages', () => {
    const urls = [
      'https://example.com/getting-started',
      'https://example.com/api-reference',
      'https://example.com/changelog',
    ];
    const result = normalizeUrlsToPaths(urls, 'https://example.com');
    expect(result.get('https://example.com/getting-started')).toBe('/getting-started.md');
    expect(result.get('https://example.com/api-reference')).toBe('/api-reference.md');
  });

  it('ignores cross-origin URLs', () => {
    const urls = [
      'https://docs.stripe.com/api/charges',
      'https://other-domain.com/page',
    ];
    const result = normalizeUrlsToPaths(urls, 'https://docs.stripe.com');
    expect(result.size).toBe(1);
    expect(result.has('https://other-domain.com/page')).toBe(false);
  });

  it('strips query params and fragments', () => {
    const urls = [
      'https://docs.example.com/api/auth?v=2#section',
      'https://docs.example.com/api/users',
    ];
    const result = normalizeUrlsToPaths(urls, 'https://docs.example.com');
    expect(result.get('https://docs.example.com/api/auth?v=2#section')).toBe('/auth.md');
  });

  it('returns empty map for empty input', () => {
    expect(normalizeUrlsToPaths([], 'https://example.com').size).toBe(0);
  });
});

describe('urlToNamespace', () => {
  it('uses domain for root URLs', () => {
    expect(urlToNamespace('https://docs.stripe.com')).toBe('docs.stripe.com');
  });

  it('includes first path segment', () => {
    expect(urlToNamespace('https://example.com/docs')).toBe('example.com-docs');
  });

  it('strips www', () => {
    expect(urlToNamespace('https://www.example.com/api')).toBe('example.com-api');
  });
});

describe('extractDomain', () => {
  it('extracts hostname', () => {
    expect(extractDomain('https://docs.stripe.com/api/charges')).toBe('docs.stripe.com');
  });
});
