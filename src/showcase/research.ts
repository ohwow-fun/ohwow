/**
 * Showcase research pipeline — parallel probe edition.
 *
 * Given a target, fires a fleet of probes concurrently (URL fetches across
 * common sub-paths, local DB queries against contacts/knowledge/findings)
 * and streams `ProbeEvent`s as they start and complete. The TUI pins each
 * probe to a line and flips its glyph from `running` → `ok`/`fail` in
 * place, giving a dense "scanner" feel without artificial delays.
 *
 * LLM-free and daemon-free: native fetch + DatabaseAdapter reads.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ShowcaseResult, ShowcaseTarget } from './types.js';

// ── Public types ─────────────────────────────────────────────────────────

export type ProbeStatus = 'running' | 'ok' | 'fail' | 'info';

export interface ProbeStats {
  pagesScanned: number;
  charsRead: number;
  linksFound: number;
  headingsFound: number;
  dbHits: number;
}

export interface ProbeEvent {
  id: string;
  /** Short human label, shown to the left of the status glyph. */
  label: string;
  status: ProbeStatus;
  /** Trailing metadata like "200 OK · 42ms · 12KB". */
  detail?: string;
  /** Elapsed ms for this probe — reported at completion. */
  elapsedMs?: number;
  /** Increments to fold into the running counter ticker. */
  stats?: Partial<ProbeStats>;
}

// ── Public helpers (kept stable for CLI / tests) ──────────────────────────

// Tokens that, when they appear in a name, pin it to "company" even if the
// surrounding words otherwise look like a Title-Case person name.
const COMPANY_SUFFIXES = new Set([
  'co',
  'corp',
  'corporation',
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'gmbh',
  'ag',
  'sa',
  'ab',
  'plc',
  'nv',
  'bv',
  'oy',
  'pty',
  'technologies',
  'tech',
  'labs',
  'systems',
  'solutions',
  'holdings',
  'group',
  'capital',
  'ventures',
  'partners',
  'industries',
  'enterprises',
]);

export function guessKind(name: string): 'person' | 'company' {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return 'company';
  const normalized = parts.map(p => p.replace(/[.,]/g, '').toLowerCase());
  if (normalized.some(p => COMPANY_SUFFIXES.has(p))) return 'company';
  const capitalized = parts.filter(p => /^[A-Z][a-z]+$/.test(p));
  return capitalized.length >= 2 ? 'person' : 'company';
}

export function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

// ── Internal: tiny HTML extractors ────────────────────────────────────────

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 ohwow-showcase';

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    });
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 200) : undefined;
}

function extractMetaDescription(html: string): string | undefined {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) return stripHtml(match[1]).slice(0, 300);
  }
  return undefined;
}

function countMatches(html: string, re: RegExp): number {
  const m = html.match(re);
  return m ? m.length : 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

const FETCH_TIMEOUT_MS = 8_000;

async function timedFetch(url: string): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  finalUrl: string;
  body: string;
  elapsedMs: number;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    });
    const body = res.ok ? await res.text() : '';
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      finalUrl: res.url || url,
      body,
      elapsedMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Internal: minimal event channel ──────────────────────────────────────

/**
 * A tiny async queue so concurrent probes can push events and the outer
 * generator can await them in FIFO order. No dependency on external
 * pub/sub; just promise latches.
 */
class EventChannel {
  private queue: ProbeEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: ProbeEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = null;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  async *drain(): AsyncGenerator<ProbeEvent, void, void> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>(resolve => {
        this.wake = resolve;
      });
    }
  }
}

// ── Probe definitions ────────────────────────────────────────────────────

interface ProbePageResult {
  id: string;
  url: string;
  ok: boolean;
  title?: string;
  description?: string;
  bodyText?: string;
  rawLength: number;
  links: number;
  headings: number;
}

async function probePage(
  ch: EventChannel,
  id: string,
  label: string,
  url: string,
): Promise<ProbePageResult> {
  ch.push({ id, label, status: 'running' });
  try {
    const r = await timedFetch(url);
    if (!r.ok) {
      ch.push({
        id,
        label,
        status: 'fail',
        detail: `${r.status} ${r.statusText || ''}`.trim(),
        elapsedMs: r.elapsedMs,
      });
      return { id, url, ok: false, rawLength: 0, links: 0, headings: 0 };
    }
    const links = countMatches(r.body, /<a\b/gi);
    const headings = countMatches(r.body, /<h[1-6]\b/gi);
    const bodyText = stripHtml(r.body);
    ch.push({
      id,
      label,
      status: 'ok',
      detail: `${r.status} · ${r.elapsedMs}ms · ${formatBytes(r.body.length)}`,
      elapsedMs: r.elapsedMs,
      stats: {
        pagesScanned: 1,
        charsRead: bodyText.length,
        linksFound: links,
        headingsFound: headings,
      },
    });
    return {
      id,
      url: r.finalUrl,
      ok: true,
      title: extractTitle(r.body),
      description: extractMetaDescription(r.body),
      bodyText,
      rawLength: r.body.length,
      links,
      headings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ch.push({ id, label, status: 'fail', detail: msg.slice(0, 60) });
    return { id, url, ok: false, rawLength: 0, links: 0, headings: 0 };
  }
}

async function probeContactMatches(
  ch: EventChannel,
  db: DatabaseAdapter,
  workspaceId: string,
  target: ShowcaseTarget,
): Promise<void> {
  const id = 'db.contacts';
  const label = 'local contacts';
  ch.push({ id, label, status: 'running' });
  const start = Date.now();
  try {
    const { data } = await db
      .from('agent_workforce_contacts')
      .select('id, name, company')
      .eq('workspace_id', workspaceId);
    const rows = (data as Array<{ id: string; name: string; company?: string }> | null) ?? [];
    const needle = target.name.toLowerCase();
    const companyNeedle = target.company?.toLowerCase();
    const hits = rows.filter(r => {
      const n = r.name?.toLowerCase() ?? '';
      const c = r.company?.toLowerCase() ?? '';
      return n.includes(needle) || (companyNeedle && c.includes(companyNeedle));
    });
    ch.push({
      id,
      label,
      status: 'ok',
      detail: `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${rows.length} contacts`,
      elapsedMs: Date.now() - start,
      stats: { dbHits: hits.length },
    });
  } catch (err) {
    ch.push({ id, label, status: 'fail', detail: err instanceof Error ? err.message : String(err) });
  }
}

async function probeKnowledge(
  ch: EventChannel,
  db: DatabaseAdapter,
  workspaceId: string,
  target: ShowcaseTarget,
): Promise<void> {
  const id = 'db.knowledge';
  const label = 'knowledge base';
  ch.push({ id, label, status: 'running' });
  const start = Date.now();
  try {
    const { data } = await db
      .from('agent_workforce_knowledge_documents')
      .select('id, title, description')
      .eq('workspace_id', workspaceId);
    const rows = (data as Array<{ title?: string; description?: string }> | null) ?? [];
    const needle = target.name.toLowerCase();
    const hits = rows.filter(
      r =>
        (r.title?.toLowerCase() ?? '').includes(needle) ||
        (r.description?.toLowerCase() ?? '').includes(needle),
    );
    ch.push({
      id,
      label,
      status: 'ok',
      detail: `${hits.length} / ${rows.length} docs mention target`,
      elapsedMs: Date.now() - start,
      stats: { dbHits: hits.length },
    });
  } catch {
    // Knowledge table may not exist in bare setups; silently skip.
    ch.push({ id, label, status: 'info', detail: 'not available' });
  }
}

async function probeFindings(
  ch: EventChannel,
  db: DatabaseAdapter,
  target: ShowcaseTarget,
): Promise<void> {
  const id = 'db.findings';
  const label = 'prior findings';
  ch.push({ id, label, status: 'running' });
  const start = Date.now();
  try {
    const { data } = await db
      .from('self_findings')
      .select('id, subject, summary')
      .eq('status', 'active')
      .limit(500);
    const rows = (data as Array<{ subject?: string; summary?: string }> | null) ?? [];
    const needle = target.name.toLowerCase();
    const hits = rows.filter(
      r =>
        (r.subject?.toLowerCase() ?? '').includes(needle) ||
        (r.summary?.toLowerCase() ?? '').includes(needle),
    );
    ch.push({
      id,
      label,
      status: 'ok',
      detail: `${hits.length} mentions across ${rows.length} findings`,
      elapsedMs: Date.now() - start,
      stats: { dbHits: hits.length },
    });
  } catch {
    ch.push({ id, label, status: 'info', detail: 'not available' });
  }
}

// ── Public entry: streaming research ─────────────────────────────────────

export interface ResearchContext {
  db: DatabaseAdapter;
  workspaceId: string;
}

/**
 * Run research as a parallel probe fleet. Yields `ProbeEvent`s as they
 * arrive (interleaved `running`/`ok`/`fail`). Returns a `ShowcaseResult`
 * with the aggregated primary page data.
 */
export async function* runResearch(
  target: ShowcaseTarget,
  ctx?: ResearchContext,
): AsyncGenerator<ProbeEvent, ShowcaseResult, void> {
  const ch = new EventChannel();
  const started = Date.now();

  // Kick off DB probes immediately (they're local and fast).
  const dbPromises: Promise<void>[] = [];
  if (ctx) {
    dbPromises.push(probeContactMatches(ch, ctx.db, ctx.workspaceId, target));
    dbPromises.push(probeKnowledge(ch, ctx.db, ctx.workspaceId, target));
    dbPromises.push(probeFindings(ch, ctx.db, target));
  }

  // URL probes: main + common sub-paths, all concurrent.
  const pagePromises: Promise<ProbePageResult>[] = [];
  if (target.url) {
    const base = normalizeUrl(target.url).replace(/\/+$/, '');
    pagePromises.push(probePage(ch, 'url.main', `fetch ${host(base)}`, base));
    const subPaths = target.kind === 'person'
      ? ['/about', '/team', '/blog']
      : ['/about', '/pricing', '/blog'];
    for (const sub of subPaths) {
      pagePromises.push(probePage(ch, `url${sub}`, `scan ${sub}`, base + sub));
    }
  }

  // Drain + close once everything is done.
  const closer = Promise.allSettled([...dbPromises, ...pagePromises]).then(() => {
    ch.push({
      id: '__summary__',
      label: 'research complete',
      status: 'info',
      detail: `${Date.now() - started}ms`,
    });
    ch.close();
  });

  for await (const event of ch.drain()) {
    yield event;
  }
  await closer;

  // Aggregate: prefer the main page's title/description/text.
  const pages = await Promise.all(pagePromises);
  const primary = pages.find(p => p.id === 'url.main' && p.ok);
  const anyOk = pages.find(p => p.ok);
  const chosen = primary ?? anyOk;

  return {
    target,
    pageUrl: chosen?.url,
    pageTitle: chosen?.title,
    pageDescription: chosen?.description,
    pageText: chosen?.bodyText?.slice(0, 4000),
  };
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
