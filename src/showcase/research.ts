/**
 * Showcase research pipeline.
 *
 * Given a target (person or company) plus optional URL, yields a stream of
 * `ShowcaseFinding` entries. The TUI wizard consumes the stream and renders
 * bullets as they arrive so the user sees research happening live.
 *
 * Intentionally LLM-free for the MVP: uses native fetch + a tiny HTML parser.
 * Later phases can plug in deep_research / scrape_search for richer signals.
 */

import type { ShowcaseFinding, ShowcaseResult, ShowcaseTarget } from './types.js';

const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 ohwow-showcase';

/** Guess whether a target looks like a person based on input shape. */
export function guessKind(name: string): 'person' | 'company' {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return 'company';
  const capitalized = parts.filter(p => /^[A-Z][a-z]+$/.test(p));
  return capitalized.length >= 2 ? 'person' : 'company';
}

/** Normalize a raw URL string; prepends https:// when no protocol is given. */
export function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

/**
 * Strip HTML to plain text, collapse whitespace, and trim. Good enough for
 * an "at a glance" snippet of a landing page; not a full readability
 * extractor.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]).slice(0, 200) : undefined;
}

function extractMetaDescription(html: string): string | undefined {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return stripHtml(m[1]).slice(0, 300);
  }
  return undefined;
}

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

/**
 * Async generator that yields research findings one at a time and returns a
 * summarized `ShowcaseResult` at the end. Yields are interleaved with small
 * awaits so the TUI gets time to repaint between bullets.
 */
export async function* runResearch(
  target: ShowcaseTarget,
): AsyncGenerator<ShowcaseFinding, ShowcaseResult, void> {
  const findings: ShowcaseFinding[] = [];

  const emit = (finding: ShowcaseFinding): ShowcaseFinding => {
    findings.push(finding);
    return finding;
  };

  yield emit({
    kind: 'resolve',
    text: `Target: ${target.name} (${target.kind === 'person' ? 'person' : 'company'})`,
  });

  if (target.company && target.kind === 'person') {
    yield emit({ kind: 'note', text: `Company: ${target.company}` });
  }
  if (target.email) {
    yield emit({ kind: 'note', text: `Email: ${target.email}` });
  }

  if (!target.url) {
    yield emit({
      kind: 'warning',
      text: 'No URL provided. Pass --url=<homepage> for a deeper read.',
    });
    return { target, findings };
  }

  const url = normalizeUrl(target.url);
  yield emit({ kind: 'fetch', text: `Fetching ${url}` });

  let html: string;
  let finalUrl = url;
  try {
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    finalUrl = res.url || url;
    if (!res.ok) {
      yield emit({
        kind: 'warning',
        text: `HTTP ${res.status} ${res.statusText}. Landing page unreadable.`,
      });
      return { target, findings, pageUrl: finalUrl };
    }
    html = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield emit({ kind: 'warning', text: `Fetch failed: ${msg}` });
    return { target, findings, pageUrl: url };
  }

  const title = extractTitle(html);
  const description = extractMetaDescription(html);
  const bodyText = stripHtml(html);
  const snippet = bodyText.slice(0, 400);

  if (title) {
    yield emit({ kind: 'title', text: `Title: ${title}` });
  }
  if (description) {
    yield emit({ kind: 'description', text: `About: ${description}` });
  }
  if (!title && !description && snippet) {
    yield emit({ kind: 'snippet', text: `Snippet: ${snippet.slice(0, 200)}…` });
  }

  return {
    target,
    findings,
    pageUrl: finalUrl,
    pageTitle: title,
    pageDescription: description,
    pageText: bodyText.slice(0, 4000),
  };
}
