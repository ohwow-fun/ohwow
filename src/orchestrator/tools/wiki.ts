/**
 * Wiki Tools — Karpathy-style markdown knowledge base layer
 *
 * Implements the "synthesis above raw chunks" pattern from Karpathy's
 * llm-wiki gist: an LLM-maintained set of markdown pages, encyclopedia-
 * style, that sit between raw KB documents and retrieval. Each page is
 * a real .md file on disk under
 *   ${OHWOW_DATA_DIR}/wiki/<workspace_id>/<slug>.md
 *
 * Why files-on-disk and not a DB table:
 *   - Karpathy: "just a git repo of markdown files." We're aligning
 *     with the spirit, which means the artifact is greppable, diffable,
 *     and survives a database wipe.
 *   - The deliverables instrumentation already records local_write_file
 *     calls, so every wiki edit auto-syncs as a deliverable into the
 *     dashboard activity timeline + calendar without a new sync layer.
 *   - Backlinks parse cleanly from `[[other-slug]]` references, no
 *     join table required.
 *
 * Frontmatter convention (every page starts with this YAML block):
 *
 *   ---
 *   title: Relevance AI
 *   slug: relevance-ai
 *   summary: Enterprise GTM automation built on AI agents.
 *   source_doc_ids: [19aa778e..., 5a3f31c8...]
 *   related: [crewai, lindy-ai]
 *   last_synthesized: 2026-04-13T07:00:00Z
 *   synthesized_by: dd2dc202...
 *   version: 3
 *   ---
 *
 *   # Relevance AI
 *   ...body...
 *
 * Slugs are kebab-case, derived from the title. They're the canonical
 * key used in URLs and `[[backlinks]]`.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { logger } from '../../lib/logger.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function dataDir(): string {
  // Same convention as the daemon's runtime.db location. OHWOW_DB_PATH
  // wins if set; otherwise default to ~/.ohwow/data.
  const dbPath = process.env.OHWOW_DB_PATH;
  if (dbPath) return dbPath.replace(/\/runtime\.db$/, '');
  return join(homedir(), '.ohwow', 'data');
}

function wikiDir(workspaceId: string): string {
  return join(dataDir(), 'wiki', workspaceId);
}

function ensureWikiDir(workspaceId: string): string {
  const dir = wikiDir(workspaceId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Slugs + frontmatter
// ---------------------------------------------------------------------------

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

export interface WikiPageFrontmatter {
  title: string;
  slug: string;
  summary?: string;
  source_doc_ids?: string[];
  related?: string[];
  last_synthesized?: string;
  synthesized_by?: string;
  version?: number;
}

export interface WikiPage {
  slug: string;
  path: string;
  frontmatter: WikiPageFrontmatter;
  body: string;
  /** Slugs referenced via `[[slug]]` in the body. */
  backlinks_to: string[];
  /** mtime in ISO format. */
  updated_at: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Parse a single value from the wiki frontmatter mini-YAML format.
 * Handles strings (with or without quotes), arrays of the form
 * `[a, b, c]` (quoted or unquoted), and integers. Returns the parsed
 * shape so callers don't have to second-guess the type.
 */
function parseFrontmatterValue(raw: string): string | string[] | number {
  let value = raw.trim();
  // Strip outer quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  // Array form `[a, b, c]`
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }
  // Integer
  if (/^\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  return value;
}

/**
 * Apply a parsed frontmatter key/value pair onto the typed
 * WikiPageFrontmatter accumulator. Switches on the known keys so the
 * compiler enforces the shape — no `as unknown as` casts.
 */
function applyFrontmatterField(target: WikiPageFrontmatter, key: string, value: string | string[] | number): void {
  switch (key) {
    case 'title':
      if (typeof value === 'string') target.title = value;
      break;
    case 'slug':
      if (typeof value === 'string') target.slug = value;
      break;
    case 'summary':
      if (typeof value === 'string') target.summary = value;
      break;
    case 'source_doc_ids':
      if (Array.isArray(value)) target.source_doc_ids = value;
      break;
    case 'related':
      if (Array.isArray(value)) target.related = value;
      break;
    case 'last_synthesized':
      if (typeof value === 'string') target.last_synthesized = value;
      break;
    case 'synthesized_by':
      if (typeof value === 'string') target.synthesized_by = value;
      break;
    case 'version':
      if (typeof value === 'number') target.version = value;
      break;
    default:
      // Unknown keys are ignored — wiki pages may grow their own metadata
      // over time and we don't want stale ones to break rendering.
      break;
  }
}

/**
 * Parse a markdown file into frontmatter + body. We use a tiny YAML-ish
 * parser (only what wiki pages need) to avoid pulling in a real YAML
 * dependency for a small fixed schema. The resulting frontmatter is
 * fully typed via WikiPageFrontmatter — no `as unknown as` casts.
 */
export function parseWikiPage(slug: string, path: string, raw: string): WikiPage {
  const match = raw.match(FRONTMATTER_RE);
  const frontmatter: WikiPageFrontmatter = { title: slug, slug };
  let body = raw;

  if (match) {
    body = match[2];
    const yaml = match[1];
    for (const line of yaml.split('\n')) {
      const kvMatch = line.match(/^([a-z_]+):\s*(.+)$/i);
      if (!kvMatch) continue;
      const key = kvMatch[1];
      const parsed = parseFrontmatterValue(kvMatch[2]);
      applyFrontmatterField(frontmatter, key, parsed);
    }
    if (!frontmatter.title) frontmatter.title = slug;
  }

  // Parse `[[backlink-slug]]` references from the body
  const backlinks_to: string[] = [];
  const linkRe = /\[\[([a-z0-9-]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(body)) !== null) {
    if (!backlinks_to.includes(m[1])) backlinks_to.push(m[1]);
  }

  let updated_at = new Date().toISOString();
  try {
    const st = statSync(path);
    updated_at = st.mtime.toISOString();
  } catch { /* noop */ }

  return { slug, path, frontmatter, body: body.trim(), backlinks_to, updated_at };
}

function serializeWikiPage(frontmatter: WikiPageFrontmatter, body: string): string {
  const fmLines: string[] = ['---'];
  fmLines.push(`title: ${frontmatter.title}`);
  fmLines.push(`slug: ${frontmatter.slug}`);
  if (frontmatter.summary) fmLines.push(`summary: ${frontmatter.summary.replace(/\n/g, ' ')}`);
  if (frontmatter.source_doc_ids && frontmatter.source_doc_ids.length > 0) {
    fmLines.push(`source_doc_ids: [${frontmatter.source_doc_ids.join(', ')}]`);
  }
  if (frontmatter.related && frontmatter.related.length > 0) {
    fmLines.push(`related: [${frontmatter.related.join(', ')}]`);
  }
  if (frontmatter.last_synthesized) fmLines.push(`last_synthesized: ${frontmatter.last_synthesized}`);
  if (frontmatter.synthesized_by) fmLines.push(`synthesized_by: ${frontmatter.synthesized_by}`);
  if (typeof frontmatter.version === 'number') fmLines.push(`version: ${frontmatter.version}`);
  fmLines.push('---', '');
  return `${fmLines.join('\n')}${body.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * wiki_list_pages — return a catalog of every wiki page in the
 * workspace with its title + summary + last update. Used by the
 * dashboard wiki index and by the orchestrator when it wants to
 * decide whether a page already exists for a topic.
 */
export async function listWikiPages(
  ctx: LocalToolContext,
  _input: Record<string, unknown>,
): Promise<ToolResult> {
  const dir = wikiDir(ctx.workspaceId);
  if (!existsSync(dir)) return { success: true, data: { pages: [] } };
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md');
  const pages: Array<{
    slug: string;
    title: string;
    summary: string | null;
    related: string[];
    backlinks_to: string[];
    updated_at: string;
    version: number | null;
  }> = [];
  for (const file of files) {
    try {
      const slug = file.replace(/\.md$/, '');
      const path = join(dir, file);
      const raw = readFileSync(path, 'utf-8');
      const page = parseWikiPage(slug, path, raw);
      pages.push({
        slug: page.slug,
        title: page.frontmatter.title,
        summary: page.frontmatter.summary ?? null,
        related: page.frontmatter.related ?? [],
        backlinks_to: page.backlinks_to,
        updated_at: page.updated_at,
        version: page.frontmatter.version ?? null,
      });
    } catch (err) {
      logger.warn({ err, file }, '[wiki] failed to parse page');
    }
  }
  // Compute incoming backlinks for each page (who references me?)
  const incomingBySlug = new Map<string, string[]>();
  for (const page of pages) {
    for (const target of page.backlinks_to) {
      const arr = incomingBySlug.get(target) ?? [];
      if (!arr.includes(page.slug)) arr.push(page.slug);
      incomingBySlug.set(target, arr);
    }
  }
  const enriched = pages.map((p) => ({
    ...p,
    backlinks_from: incomingBySlug.get(p.slug) ?? [],
  }));
  enriched.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return { success: true, data: { pages: enriched } };
}

/**
 * wiki_read_page — return one page by slug. Includes the raw markdown
 * body so the dashboard renderer can show it properly formatted, and
 * a `backlinks_from` array of every other page that references this
 * one (computed by walking the directory).
 */
export async function readWikiPage(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const slug = (input.slug as string | undefined)?.trim();
  if (!slug) return { success: false, error: 'slug is required' };
  const dir = wikiDir(ctx.workspaceId);
  const path = join(dir, `${slug}.md`);
  if (!existsSync(path)) return { success: false, error: `Wiki page "${slug}" not found` };
  const raw = readFileSync(path, 'utf-8');
  const page = parseWikiPage(slug, path, raw);

  // Compute incoming backlinks by scanning every other page in the dir.
  const backlinks_from: string[] = [];
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md') || file === `${slug}.md` || file === 'index.md' || file === 'log.md') continue;
      try {
        const otherSlug = file.replace(/\.md$/, '');
        const otherRaw = readFileSync(join(dir, file), 'utf-8');
        const other = parseWikiPage(otherSlug, join(dir, file), otherRaw);
        if (other.backlinks_to.includes(slug)) backlinks_from.push(otherSlug);
      } catch { /* noop */ }
    }
  }

  return {
    success: true,
    data: {
      slug: page.slug,
      title: page.frontmatter.title,
      summary: page.frontmatter.summary ?? null,
      body: page.body,
      source_doc_ids: page.frontmatter.source_doc_ids ?? [],
      related: page.frontmatter.related ?? [],
      backlinks_to: page.backlinks_to,
      backlinks_from,
      version: page.frontmatter.version ?? null,
      synthesized_by: page.frontmatter.synthesized_by ?? null,
      last_synthesized: page.frontmatter.last_synthesized ?? null,
      updated_at: page.updated_at,
      path: page.path,
    },
  };
}

/**
 * wiki_write_page — write or overwrite a page on disk. Tools/orchestrator
 * call this with a fully-synthesized title + body; the helper handles
 * frontmatter, slug derivation, and version bumping. Also appends an
 * entry to log.md.
 */
export async function writeWikiPage(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const title = (input.title as string | undefined)?.trim();
  const body = (input.body as string | undefined) ?? '';
  if (!title) return { success: false, error: 'title is required' };
  if (!body || body.length < 50) {
    return { success: false, error: 'body is required and must be substantive (≥50 chars)' };
  }

  const explicitSlug = (input.slug as string | undefined)?.trim();
  const slug = explicitSlug || slugify(title);
  if (!slug) return { success: false, error: 'could not derive a slug from title' };

  const sourceDocIds = Array.isArray(input.source_doc_ids) ? (input.source_doc_ids as string[]) : [];
  const related = Array.isArray(input.related) ? (input.related as string[]) : [];
  const summary = (input.summary as string | undefined) ?? '';

  const dir = ensureWikiDir(ctx.workspaceId);
  const path = join(dir, `${slug}.md`);

  let prevVersion = 0;
  if (existsSync(path)) {
    try {
      const prevRaw = readFileSync(path, 'utf-8');
      const prev = parseWikiPage(slug, path, prevRaw);
      prevVersion = prev.frontmatter.version ?? 0;
    } catch { /* noop */ }
  }

  const now = new Date().toISOString();
  const frontmatter: WikiPageFrontmatter = {
    title,
    slug,
    summary: summary || undefined,
    source_doc_ids: sourceDocIds.length > 0 ? sourceDocIds : undefined,
    related: related.length > 0 ? related : undefined,
    last_synthesized: now,
    synthesized_by: ctx.currentGuideAgentId ?? ctx.currentAgentId ?? undefined,
    version: prevVersion + 1,
  };
  const fileContent = serializeWikiPage(frontmatter, body);
  writeFileSync(path, fileContent, 'utf-8');

  // Append a log entry. log.md is the wiki's auditable history.
  try {
    const logPath = join(dir, 'log.md');
    const isUpdate = prevVersion > 0;
    const entry = `- ${now}: ${isUpdate ? 'updated' : 'created'} [[${slug}]] (${title}) — v${prevVersion + 1}\n`;
    if (existsSync(logPath)) {
      const existing = readFileSync(logPath, 'utf-8');
      writeFileSync(logPath, existing + entry, 'utf-8');
    } else {
      writeFileSync(logPath, `# Wiki Log\n\n${entry}`, 'utf-8');
    }
  } catch (err) {
    logger.warn({ err, slug }, '[wiki] failed to append log entry');
  }

  return {
    success: true,
    data: {
      slug,
      path,
      title,
      version: prevVersion + 1,
      message: prevVersion > 0
        ? `Updated wiki page "${title}" (v${prevVersion + 1})`
        : `Created wiki page "${title}"`,
    },
  };
}

/**
 * wiki_read_log — return recent entries from the workspace's wiki log.
 * The log is the auditable history of every synthesis / update / lint
 * pass and powers the activity timeline's "what changed in the wiki"
 * feed.
 */
export async function readWikiLog(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const limit = Math.min(200, (input.limit as number) || 50);
  const dir = wikiDir(ctx.workspaceId);
  const logPath = join(dir, 'log.md');
  if (!existsSync(logPath)) return { success: true, data: { entries: [] } };
  const raw = readFileSync(logPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.startsWith('- '));
  const entries = lines.slice(-limit).reverse().map((l) => l.replace(/^- /, ''));
  return { success: true, data: { entries } };
}

/**
 * wiki_read_index — read or auto-generate the index.md catalog. If
 * no index file exists yet, derive one from the directory listing
 * with one-line summaries per page. This matches Karpathy's
 * `index.md` pattern: the catalog is the user's home page, not the
 * raw file list.
 */
export async function readWikiIndex(
  ctx: LocalToolContext,
  _input: Record<string, unknown>,
): Promise<ToolResult> {
  const dir = wikiDir(ctx.workspaceId);
  const indexPath = join(dir, 'index.md');
  if (existsSync(indexPath)) {
    const raw = readFileSync(indexPath, 'utf-8');
    return { success: true, data: { source: 'file', body: raw, path: indexPath } };
  }
  // Auto-generate from listing
  const list = await listWikiPages(ctx, {});
  if (!list.success || !list.data) return { success: true, data: { source: 'empty', body: '', path: indexPath } };
  const pages = (list.data as { pages: Array<{ slug: string; title: string; summary: string | null; updated_at: string }> }).pages;
  const lines = ['# Wiki Index', '', `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`, ''];
  for (const p of pages) {
    const summary = p.summary ? ` — ${p.summary}` : '';
    lines.push(`- [[${p.slug}]] ${p.title}${summary}`);
  }
  return { success: true, data: { source: 'derived', body: lines.join('\n'), path: indexPath } };
}
