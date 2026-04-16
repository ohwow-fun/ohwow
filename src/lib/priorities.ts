/**
 * priorities — operator-authored markdown priority docs that live in
 * each workspace's dataDir.
 *
 * Problem this solves
 * -------------------
 * The autonomous loop picks candidates via the value ranker. The
 * ranker's signals are implicit (experiment-ids, paths, subjects).
 * Operators have their own explicit priorities they want the loop to
 * steer toward — "tune the market_signal rubric this week", "drop
 * the 'Hey' opener from DM drafts" — that don't naturally map to any
 * of the ranker's code-local signals.
 *
 * The priorities directory is the bridge. Each markdown file is one
 * priority with frontmatter declaring status + tags. The context pack
 * surfaces active priorities to the LLM prompt. The value ranker
 * boosts candidates whose signals intersect a priority's tags. After
 * a cross-domain patch lands, the author appends a work-log entry to
 * the matching priority files so the operator sees real-time progress
 * by opening the file in an editor or running `ls priorities/`.
 *
 * Directory layout (per workspace)
 * --------------------------------
 *   ~/.ohwow/workspaces/<name>/priorities/
 *     README.md                       index + conventions
 *     <slug>.md                       one file per priority, any name
 *
 * File shape
 * ----------
 *   ---
 *   title: "Market signal rubric tuning"
 *   status: active                    pending | active | done | archived
 *   tags: [attribution, market-signal, rubric]
 *   created_at: 2026-04-16T14:00:00Z
 *   ---
 *
 *   ## Goal
 *   One-line what-for.
 *
 *   ## Work Log
 *
 *   ### 2026-04-16T15:00Z — ohwow/patch-author
 *   Landed commit abc123 — adjusted bucket weight ...
 *
 * Minimal frontmatter requirement: title + status. Everything else is
 * optional. Reader never throws — a malformed file is skipped with a
 * debug log.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

export type PriorityStatus = 'pending' | 'active' | 'done' | 'archived';

export interface PriorityDoc {
  /** Absolute path on disk. */
  filePath: string;
  /** Stable slug derived from filename (no .md, lowercased). */
  slug: string;
  title: string;
  status: PriorityStatus;
  tags: string[];
  createdAt: string | null;
  /** First 500 chars of the body after frontmatter; useful for prompt context. */
  summary: string;
}

const VALID_STATUSES: readonly PriorityStatus[] = ['pending', 'active', 'done', 'archived'];

/**
 * Parse a markdown file's frontmatter + body. Minimal YAML — only
 * supports the subset we declare (scalar string + array-of-strings).
 * Returns null if the file has no frontmatter or is missing required
 * title + status.
 */
export function parsePriorityDoc(filePath: string, content: string): PriorityDoc | null {
  const slug = path.basename(filePath).replace(/\.md$/i, '').toLowerCase();
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const frontmatter = fmMatch[1];
  const body = fmMatch[2];
  const parsed = parseFrontmatter(frontmatter);
  const title = typeof parsed.title === 'string' ? parsed.title : null;
  const rawStatus = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : null;
  const status = rawStatus && (VALID_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as PriorityStatus)
    : null;
  if (!title || !status) return null;
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase())
    : [];
  const createdAt = typeof parsed.created_at === 'string' ? parsed.created_at : null;
  const summary = body.trim().slice(0, 500);
  return { filePath, slug, title, status, tags, createdAt, summary };
}

/**
 * Extremely small YAML subset: scalar strings (quoted or bare),
 * `[...]` inline string arrays, `# comments`. Lines that don't match
 * are skipped rather than throwing — good-enough for the priority
 * frontmatter without pulling in a yaml dependency.
 */
function parseFrontmatter(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (inner.length === 0) {
        out[key] = [];
        continue;
      }
      out[key] = inner
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter((s) => s.length > 0);
      continue;
    }
    out[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/**
 * Enumerate every priority doc in the workspace's priorities dir.
 * Fail-soft: missing dir = empty array, unreadable file = skipped,
 * malformed frontmatter = skipped with a debug log.
 */
export function readPriorityDocs(workspaceDataDir: string): PriorityDoc[] {
  const dir = path.join(workspaceDataDir, 'priorities');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const docs: PriorityDoc[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (name.toLowerCase() === 'readme.md') continue;
    const filePath = path.join(dir, name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.debug({ err, filePath }, '[priorities] read failed');
      continue;
    }
    const doc = parsePriorityDoc(filePath, content);
    if (!doc) {
      logger.debug({ filePath }, '[priorities] malformed or missing required frontmatter');
      continue;
    }
    docs.push(doc);
  }
  // Stable ordering: status (active first) then slug.
  const statusRank: Record<PriorityStatus, number> = {
    active: 0,
    pending: 1,
    done: 2,
    archived: 3,
  };
  docs.sort((a, b) => {
    if (statusRank[a.status] !== statusRank[b.status]) {
      return statusRank[a.status] - statusRank[b.status];
    }
    return a.slug.localeCompare(b.slug);
  });
  return docs;
}

export function readActivePriorities(workspaceDataDir: string): PriorityDoc[] {
  return readPriorityDocs(workspaceDataDir).filter((p) => p.status === 'active');
}

export interface AppendWorkLogInput {
  priority: PriorityDoc;
  actor: string;
  message: string;
  at?: Date;
}

/**
 * Append a work-log entry to a priority file under the `## Work Log`
 * heading. Creates the heading if missing. Never throws — a write
 * failure is swallowed with a debug log so a permission error in the
 * priorities dir doesn't block the commit path that triggered it.
 *
 * Entry format:
 *   ### <ISO ts> — <actor>
 *   <message>
 */
export function appendWorkLogEntry(input: AppendWorkLogInput): void {
  const at = input.at ?? new Date();
  const ts = at.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const entry = `\n### ${ts} — ${input.actor}\n${input.message.trim()}\n`;
  try {
    const current = fs.readFileSync(input.priority.filePath, 'utf-8');
    let next: string;
    if (/^##\s+Work Log\s*$/m.test(current)) {
      // Insert right after the heading so newest entries sit at the top.
      next = current.replace(
        /^(##\s+Work Log\s*\n)/m,
        `$1${entry}`,
      );
    } else {
      const trailingNewline = current.endsWith('\n') ? '' : '\n';
      next = `${current}${trailingNewline}\n## Work Log\n${entry}`;
    }
    fs.writeFileSync(input.priority.filePath, next, 'utf-8');
  } catch (err) {
    logger.debug({ err, file: input.priority.filePath }, '[priorities] work-log append failed');
  }
}

/**
 * Given a candidate's signals (experiment id, subject, affected paths),
 * return the active priorities whose tags match. Match is case-insensitive
 * substring: a priority tagged `attribution` matches a candidate whose
 * subject is `attribution:rollup` or whose experiment id is
 * `attribution-observer`.
 */
export function matchActivePriorities(
  active: readonly PriorityDoc[],
  signals: {
    experimentId?: string | null;
    subject?: string | null;
    paths?: readonly string[];
  },
): PriorityDoc[] {
  const haystacks: string[] = [];
  if (signals.experimentId) haystacks.push(signals.experimentId.toLowerCase());
  if (signals.subject) haystacks.push(signals.subject.toLowerCase());
  if (signals.paths) haystacks.push(...signals.paths.map((p) => p.toLowerCase()));
  if (haystacks.length === 0) return [];
  const matches: PriorityDoc[] = [];
  for (const p of active) {
    for (const tag of p.tags) {
      if (tag.length === 0) continue;
      if (haystacks.some((h) => h.includes(tag))) {
        matches.push(p);
        break;
      }
    }
  }
  return matches;
}

/**
 * Render a markdown README.md that indexes the priorities directory.
 * Pure function — callers decide whether to write it out. The header
 * documents the convention so an operator opening the dir for the
 * first time immediately sees how to add a priority.
 */
export function renderPrioritiesReadme(docs: readonly PriorityDoc[]): string {
  const byStatus: Record<PriorityStatus, PriorityDoc[]> = {
    active: [],
    pending: [],
    done: [],
    archived: [],
  };
  for (const d of docs) byStatus[d.status].push(d);

  const section = (label: string, status: PriorityStatus): string => {
    const rows = byStatus[status];
    if (rows.length === 0) return `## ${label}\n\n(none)\n`;
    const lines = rows.map(
      (d) => `- [${d.title}](./${path.basename(d.filePath)})${d.tags.length > 0 ? ` — tags: ${d.tags.join(', ')}` : ''}`,
    );
    return `## ${label}\n\n${lines.join('\n')}\n`;
  };

  return [
    '# Priorities',
    '',
    'Operator-authored markdown docs that steer the autonomous loop.',
    'Each file carries `title` + `status` frontmatter (status ∈ pending,',
    'active, done, archived). Optional `tags:` list is the join key the',
    'loop uses to match committed patches back to priorities.',
    '',
    'Add a new priority by dropping a markdown file here. Promote it by',
    'editing the `status:` field. The loop reads this directory on every',
    'context-pack build and appends a work-log entry under `## Work Log`',
    'whenever a commit lands whose signals match a priority\'s tags.',
    '',
    section('Active', 'active'),
    section('Pending', 'pending'),
    section('Done', 'done'),
    section('Archived', 'archived'),
  ].join('\n');
}
