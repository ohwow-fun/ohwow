import { describe, it, expect } from 'vitest';
import { SCRAPE_DIFF_REGISTRY } from '../scrape-diff-registry.js';

/**
 * Structural invariants for SCRAPE_DIFF_REGISTRY.
 *
 * This file freezes the fix in runtime SHA 0a30777 — both HN rows must
 * point at the Algolia JSON API (hn.algolia.com/api/v1/search_by_date)
 * rather than the SPA shell at news.ycombinator.com / hn.algolia.com,
 * which previously returned a 37-char "no change" finding forever.
 *
 * These are pure struct assertions over the imported registry — no
 * network calls — so the test runs offline in CI.
 */
describe('SCRAPE_DIFF_REGISTRY', () => {
  it('every entry has all required fields', () => {
    expect(SCRAPE_DIFF_REGISTRY.length).toBeGreaterThan(0);
    for (const entry of SCRAPE_DIFF_REGISTRY) {
      expect(entry.id, `row missing id: ${JSON.stringify(entry)}`).toBeTruthy();
      expect(entry.name, `row ${entry.id} missing name`).toBeTruthy();
      expect(entry.url, `row ${entry.id} missing url`).toBeTruthy();
      expect(entry.subjectKey, `row ${entry.id} missing subjectKey`).toBeTruthy();
      expect(entry.category, `row ${entry.id} missing category`).toBeTruthy();
      expect(entry.hypothesis, `row ${entry.id} missing hypothesis`).toBeTruthy();
      // URL must parse.
      expect(() => new URL(entry.url), `row ${entry.id} has unparseable url: ${entry.url}`).not.toThrow();
    }
  });

  it('ids are unique across the registry', () => {
    const ids = SCRAPE_DIFF_REGISTRY.map((r) => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('subjectKeys are unique across the registry', () => {
    const keys = SCRAPE_DIFF_REGISTRY.map((r) => r.subjectKey);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('both hn-* entries use the Algolia JSON API endpoint (not the SPA shell)', () => {
    const hnRows = SCRAPE_DIFF_REGISTRY.filter((r) => r.id.startsWith('scrape-diff:hn-'));
    expect(hnRows.length).toBeGreaterThanOrEqual(2);
    for (const row of hnRows) {
      expect(
        row.url,
        `HN row ${row.id} must use Algolia JSON API to avoid SPA-shell 37-char findings`,
      ).toContain('hn.algolia.com/api/v1/search_by_date');
    }
  });

  it('hn-ai-agent-pain entry exists with the expected subjectKey', () => {
    const row = SCRAPE_DIFF_REGISTRY.find((r) => r.id === 'scrape-diff:hn-ai-agent-pain');
    expect(row, 'hn-ai-agent-pain row must exist').toBeDefined();
    expect(row?.subjectKey).toBe('market:hn.algolia.com/ai-agent-pain');
    expect(row?.url).toContain('query=AI%20agent');
  });

  it('hn-local-first-ai entry exists and no longer points at the SPA URL', () => {
    const row = SCRAPE_DIFF_REGISTRY.find((r) => r.id === 'scrape-diff:hn-local-first-ai');
    expect(row, 'hn-local-first-ai row must exist').toBeDefined();
    expect(row?.url).toContain('hn.algolia.com/api/v1/search_by_date');
    expect(row?.url).toContain('query=local-first%20AI');
    // Guard: no legacy SPA-shell URLs.
    expect(row?.url).not.toContain('news.ycombinator.com');
  });
});
