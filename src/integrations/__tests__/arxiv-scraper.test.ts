import { describe, it, expect } from 'vitest';
import { buildArxivUrl, parseArxivAtom } from '../arxiv-scraper.js';

describe('buildArxivUrl', () => {
  it('uses all: prefix and relevance sort by default', () => {
    const url = buildArxivUrl({ query: 'sparse reward shaping' });
    expect(url).toContain('https://export.arxiv.org/api/query');
    expect(url).toContain('search_query=all%3Asparse+reward+shaping');
    expect(url).toContain('sortBy=relevance');
  });

  it('appends cat: filter as an AND clause when category is set', () => {
    const url = buildArxivUrl({ query: 'credit assignment', category: 'cs.LG' });
    expect(url).toContain('all%3Acredit+assignment+AND+cat%3Acs.LG');
  });

  it('caps max_results at 25 (arXiv courtesy)', () => {
    const url = buildArxivUrl({ query: 'x', max_results: 500 });
    expect(url).toContain('max_results=25');
  });

  it('preserves explicit submittedDate override', () => {
    const url = buildArxivUrl({ query: 'x', sort_by: 'submittedDate' });
    expect(url).toContain('sortBy=submittedDate');
  });
});

describe('parseArxivAtom', () => {
  const sampleFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2103.04529v3</id>
    <title>Self-Supervised Online Reward Shaping in Sparse-Reward Environments</title>
    <summary>
      We introduce Self-supervised Online Reward Shaping (SORS).
    </summary>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
    <published>2021-03-08T00:00:00Z</published>
    <arxiv:primary_category term="cs.LG"/>
    <link title="pdf" href="http://arxiv.org/pdf/2103.04529v3" rel="related"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2306.11885v1</id>
    <title>Reward Shaping via Diffusion Process</title>
    <summary>RL exploration exploitation tradeoff.</summary>
    <author><name>Carol Chen</name></author>
    <published>2023-06-20T00:00:00Z</published>
    <arxiv:primary_category term="cs.LG"/>
  </entry>
</feed>`;

  it('extracts id, title, authors, date, and category from each entry', () => {
    const papers = parseArxivAtom(sampleFeed);
    expect(papers).toHaveLength(2);
    expect(papers[0].id).toBe('2103.04529v3');
    expect(papers[0].title).toBe('Self-Supervised Online Reward Shaping in Sparse-Reward Environments');
    expect(papers[0].authors).toEqual(['Alice Smith', 'Bob Jones']);
    expect(papers[0].published).toBe('2021-03-08T00:00:00Z');
    expect(papers[0].primary_category).toBe('cs.LG');
    expect(papers[0].pdf_url).toBe('http://arxiv.org/pdf/2103.04529v3');
    expect(papers[0].summary).toContain('Self-supervised Online Reward Shaping');
  });

  it('handles entries without a pdf link (returns null)', () => {
    const papers = parseArxivAtom(sampleFeed);
    expect(papers[1].pdf_url).toBeNull();
  });

  it('collapses whitespace in title and summary', () => {
    const papers = parseArxivAtom(sampleFeed);
    expect(papers[0].summary).not.toMatch(/\n/);
    expect(papers[0].title).not.toMatch(/\s{2,}/);
  });

  it('returns empty array when there are no entries', () => {
    expect(parseArxivAtom('<feed></feed>')).toEqual([]);
  });

  it('skips malformed entries missing id or title', () => {
    const bad = `<feed><entry><id>http://arxiv.org/abs/x</id></entry></feed>`;
    expect(parseArxivAtom(bad)).toEqual([]);
  });
});
