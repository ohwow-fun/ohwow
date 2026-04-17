import { describe, it, expect } from 'vitest';
import { normalizeScrapeContent } from '../normalize-scrape-content.js';

describe('normalizeScrapeContent', () => {
  it('strips ISO-8601 datetimes', () => {
    const out = normalizeScrapeContent('Released on 2026-04-16T12:34:56Z — see changelog.');
    expect(out).not.toMatch(/2026-04-16/);
    expect(out).toContain('Released on');
    expect(out).toContain('see changelog');
  });

  it('strips plain ISO dates', () => {
    const out = normalizeScrapeContent('Published 2026-04-16 — v0.9.0');
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(out).toContain('v0.9.0');
  });

  it('strips long-form dates like "Apr 14, 2026"', () => {
    const out = normalizeScrapeContent('Released April 14, 2026 in beta');
    expect(out).not.toMatch(/April\s+14/);
    expect(out).toContain('in beta');
  });

  it('strips relative time phrases', () => {
    const cases = [
      'updated 3 minutes ago',
      'posted yesterday',
      '5 hours ago by alice',
      'just now',
      'last week',
    ];
    for (const c of cases) {
      const out = normalizeScrapeContent(c);
      expect(out).not.toMatch(/\b(?:ago|yesterday|just now|last week)\b/i);
    }
  });

  it('strips volatile view / like / star counters', () => {
    const cases = [
      '1,234 views',
      '42 likes',
      '1.2K stars',
      '8.5M downloads',
      '999 comments',
      '3 forks',
    ];
    for (const c of cases) {
      const out = normalizeScrapeContent(c);
      expect(out).not.toMatch(/\d/);
    }
  });

  it('preserves prices (USD / EUR / monthly)', () => {
    const out = normalizeScrapeContent('Pro $9.99/mo\nTeam $29/month\nEnterprise €499/year');
    expect(out).toContain('$9.99');
    expect(out).toContain('$29');
    expect(out).toContain('€499');
    expect(out).toContain('Pro');
    expect(out).toContain('Team');
    expect(out).toContain('Enterprise');
  });

  it('preserves plan names and feature lists', () => {
    const input = [
      'Free',
      'Unlimited projects',
      'Pro',
      '$9/mo',
      'Custom domains',
      'Priority support',
    ].join('\n');
    const out = normalizeScrapeContent(input);
    for (const line of ['Free', 'Unlimited projects', 'Pro', '$9/mo', 'Custom domains']) {
      expect(out).toContain(line);
    }
  });

  it('collapses multi-space runs and blank lines', () => {
    const input = 'Pro   Plan\n\n\n\n$9/mo   per seat';
    const out = normalizeScrapeContent(input);
    expect(out).toBe('Pro Plan\n\n$9/mo per seat');
  });

  it('is idempotent', () => {
    const input =
      'Released 2026-04-16 — Pro $9/mo · 1,234 stars · updated 3 days ago';
    const once = normalizeScrapeContent(input);
    const twice = normalizeScrapeContent(once);
    expect(twice).toBe(once);
  });

  it('returns empty string for empty input', () => {
    expect(normalizeScrapeContent('')).toBe('');
  });
});
