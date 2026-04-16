/**
 * arXiv Atom-feed scraper for the self-improvement loop.
 *
 * Hits `http://export.arxiv.org/api/query?...` (the official, CORS-
 * friendly API) and returns a normalised `ArxivPaper[]` the
 * research-ingest probe can write into self_findings / the KB.
 *
 * Design notes:
 *   - No API key required; arXiv rate-limits to ~1 req/3s anonymously.
 *     The probe caller is responsible for honouring that — this module
 *     makes one request per call.
 *   - Atom XML is parsed with a minimal regex-based extractor. A full
 *     XML library would be cleaner but adds a dep for a format we read
 *     one shape of; the regex is pinned to the known arXiv layout.
 *   - The scraper is pure I/O — no DB, no KB coupling. Callers decide
 *     what to do with the results (log them, ingest them, both).
 *
 * Graceful failure: on network error, HTTP non-200, or parse miss the
 * function returns an empty array rather than throwing. Experiments
 * are supposed to be cheap and idempotent; a single transient arXiv
 * outage should never crash the loop.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { logger } from '../lib/logger.js';

export interface ArxivPaper {
  /** Full arXiv id (e.g. "2401.12345v1"). Stable across requests. */
  id: string;
  title: string;
  /** Abstract. Whitespace-collapsed. */
  summary: string;
  authors: string[];
  /** ISO-8601 timestamp of first submission. */
  published: string;
  /** Direct PDF url if arXiv exposes one. */
  pdf_url: string | null;
  /** Primary category (e.g. "cs.LG"). */
  primary_category: string | null;
}

export interface ScrapeOptions {
  /**
   * Free-text search query. arXiv supports field-prefixed syntax
   * (`ti:`, `abs:`, `cat:`) but plain words work and default to
   * all-fields match.
   */
  query: string;
  /** Max papers returned. arXiv caps at 2000; this module caps at 25. */
  max_results?: number;
  /** Sort field. `submittedDate` biases toward fresh research. */
  sort_by?: 'relevance' | 'lastUpdatedDate' | 'submittedDate';
  /** Category filter appended as an AND clause to the query. */
  category?: string;
  /** Override host for tests. Defaults to export.arxiv.org. */
  host?: string;
  /** Override path prefix for tests. Defaults to /api/query. */
  path_prefix?: string;
}

export function buildArxivUrl(opts: ScrapeOptions): string {
  const params = new URLSearchParams();
  // arXiv tokenises the `all:` field on whitespace and ANDs them. Wrapping
  // the whole query in parens + "AND cat:" works but produces zero hits
  // when the query is long — the conjunction becomes too narrow. Using
  // all: field prefix + category filter as a separate AND clause yields
  // the same intent with much better recall.
  const base = `all:${opts.query}`;
  const q = opts.category ? `${base} AND cat:${opts.category}` : base;
  params.set('search_query', q);
  params.set('start', '0');
  params.set('max_results', String(Math.min(opts.max_results ?? 5, 25)));
  // Default to relevance — submittedDate + broad queries returned the
  // most-recent cs.LG paper that matched ANY keyword, producing
  // essentially noise. Callers that explicitly want fresh-first can
  // still pass sort_by: 'submittedDate'.
  params.set('sortBy', opts.sort_by ?? 'relevance');
  params.set('sortOrder', 'descending');
  const host = opts.host ?? 'export.arxiv.org';
  const prefix = opts.path_prefix ?? '/api/query';
  // arXiv redirects http → https; use https directly to skip the hop and
  // avoid the "scraper silently returned zero" failure mode.
  return `https://${host}${prefix}?${params.toString()}`;
}

interface FetchResult {
  status: number;
  body: string;
}

function fetchUrl(url: string, timeoutMs = 8000): Promise<FetchResult> {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const transport = u.protocol === 'https:' ? https : http;
      const req = transport.get(
        { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, timeout: timeoutMs },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, body: '' });
      });
    } catch {
      resolve({ status: 0, body: '' });
    }
  });
}

/**
 * Minimal Atom parser pinned to the shape arXiv returns. Each <entry>
 * becomes one ArxivPaper. Unknown fields are dropped. We pull just
 * what the probe needs — title, id, summary, authors, pdf link,
 * primary category, published date.
 */
export function parseArxivAtom(xml: string): ArxivPaper[] {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const papers: ArxivPaper[] = [];
  for (const block of entries) {
    const id = (block.match(/<id>([^<]+)<\/id>/) ?? [])[1]?.trim() ?? '';
    // arXiv id is the trailing path segment: http://arxiv.org/abs/2401.12345v1
    const idShort = id.split('/').pop() ?? id;
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1]
      ?.replace(/\s+/g, ' ')
      .trim() ?? '';
    const summary = (block.match(/<summary>([\s\S]*?)<\/summary>/) ?? [])[1]
      ?.replace(/\s+/g, ' ')
      .trim() ?? '';
    const authors = [...block.matchAll(/<author>\s*<name>([^<]+)<\/name>\s*<\/author>/g)].map(
      (m) => m[1].trim(),
    );
    const published = (block.match(/<published>([^<]+)<\/published>/) ?? [])[1]?.trim() ?? '';
    const primaryCategory =
      (block.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) ?? [])[1] ?? null;
    const pdfLink = (block.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/) ?? [])[1] ?? null;
    if (!idShort || !title) continue;
    papers.push({
      id: idShort,
      title,
      summary,
      authors,
      published,
      pdf_url: pdfLink,
      primary_category: primaryCategory,
    });
  }
  return papers;
}

/**
 * Fetch arXiv papers matching the query. Returns `[]` on any network
 * or parse failure. Caller should treat an empty result as "nothing
 * to cite" and emit a warning-level finding if repeated.
 */
export async function searchArxiv(opts: ScrapeOptions): Promise<ArxivPaper[]> {
  const url = buildArxivUrl(opts);
  const result = await fetchUrl(url);
  if (result.status !== 200 || !result.body) {
    logger.debug({ status: result.status, url }, '[arxiv] fetch returned no body');
    return [];
  }
  try {
    return parseArxivAtom(result.body);
  } catch (err) {
    logger.debug({ err }, '[arxiv] parse failed');
    return [];
  }
}
