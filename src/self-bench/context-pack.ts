/**
 * Context pack — shared prompt-context builder for the autonomous
 * author + proposal pipelines.
 *
 * Today (pre-context-pack) the patch-author's LLM prompt sees:
 *   - the source file it's about to edit
 *   - the justifying finding blob
 *   - the roadmap excerpt (Active Focus / Known Gaps)
 *   - recent hippocampus reflections
 *
 * That's code-local. It tells the model "here's the bug, fix it." It
 * never tells the model WHICH bugs would move revenue most, or what
 * the operator keeps rejecting, or which attribution bucket is
 * bleeding leads. The context pack widens that window.
 *
 * Each source is independent and fail-soft. A missing DB table,
 * absent JSONL file, or broken fs read yields `null` for that
 * section, never throws. Callers render the pack as a sequence of
 * `<context name="...">` blocks the model can read; empty sections
 * stay empty so absent signals don't bias the model into
 * hallucinating them.
 *
 * Privacy: sections that carry user-authored prose (rejection notes,
 * roadmap gaps) pass through redactForPrompt before the model ever
 * sees them. Purely structural data (goal rows, attribution blob)
 * passes through as-is — those live in sqlite under our workspace
 * and don't carry arbitrary user text.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';
import { redactForPrompt } from '../lib/prompt-redact.js';
import { getRuntimeConfig } from './runtime-config.js';
import { readApprovalRows, type ApprovalEntry } from '../scheduling/approval-queue.js';
import { recentRevertedAttempts } from '../lib/patches-attempted-log.js';
import { readActivePriorities } from '../lib/priorities.js';

export interface ContextPackInputs {
  db: DatabaseAdapter;
  workspaceId: string;
  /** Repo root, for reading roadmap/*.md. Null = skip roadmap section. */
  repoRoot: string | null;
  /** Path to the workspace's x-approvals.jsonl. Null = skip rejection section. */
  approvalsJsonlPath: string | null;
  /**
   * Workspace dataDir — used to read operator-authored priority docs
   * from `<dataDir>/priorities/*.md`. Null = skip active-priorities section.
   */
  workspaceDataDir?: string | null;
  /** Lookback window for recent findings. Default 24h. */
  findingsWindowHours?: number;
  /** Max findings included. Default 20 (roughly ~3KB of prompt). */
  maxFindings?: number;
  /** Max recent rejection rows parsed from approvals. Default 30. */
  maxRejections?: number;
}

export interface ContextPackSection {
  name: string;
  /** Prose body of the section — already redacted and size-bounded. */
  body: string;
}

export interface ContextPack {
  sections: ContextPackSection[];
  /**
   * Render all sections as `<context name="...">...</context>` blocks
   * separated by a blank line, ready to append to an LLM prompt body.
   * Returns an empty string when no sections were included.
   */
  toPromptString(): string;
  /** For diagnostics / the preview script. */
  summary: () => Array<{ name: string; bytes: number }>;
}

const DEFAULT_FINDINGS_WINDOW_HOURS = 24;
const DEFAULT_MAX_FINDINGS = 20;
const DEFAULT_MAX_REJECTIONS = 30;
/** Per-section soft ceiling before truncation. Keeps total prompt bounded. */
const PER_SECTION_MAX_BYTES = 4096;

/**
 * Build the context pack. Each source runs in parallel; a failure in
 * one source doesn't block the others. The builder never throws.
 */
export async function buildContextPack(inputs: ContextPackInputs): Promise<ContextPack> {
  const windowHours = inputs.findingsWindowHours ?? DEFAULT_FINDINGS_WINDOW_HOURS;
  const maxFindings = inputs.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const maxRejections = inputs.maxRejections ?? DEFAULT_MAX_REJECTIONS;

  const [
    findings,
    goals,
    rejections,
    attemptedPatches,
  ] = await Promise.all([
    collectRecentFindings(inputs.db, windowHours, maxFindings),
    collectActiveGoals(inputs.db, inputs.workspaceId),
    collectOperatorRejections(inputs.approvalsJsonlPath, maxRejections),
    collectPatchesAttempted(inputs.db, inputs.workspaceId),
  ]);

  const revenueGap = collectRevenueGapFocus();
  const attribution = collectAttributionFindings();
  const roadmap = collectRoadmapGaps(inputs.repoRoot);
  const priorities = collectActivePriorities(inputs.workspaceDataDir ?? null);

  const maybeSections: Array<ContextPackSection | null> = [
    priorities,
    findings,
    revenueGap,
    attribution,
    goals,
    rejections,
    roadmap,
    attemptedPatches,
  ];

  const sections: ContextPackSection[] = [];
  for (const s of maybeSections) {
    if (!s) continue;
    sections.push({ name: s.name, body: truncate(s.body, PER_SECTION_MAX_BYTES) });
  }

  return {
    sections,
    toPromptString() {
      if (sections.length === 0) return '';
      return sections
        .map((s) => `<context name="${s.name}">\n${s.body}\n</context>`)
        .join('\n\n');
    },
    summary() {
      return sections.map((s) => ({ name: s.name, bytes: Buffer.byteLength(s.body, 'utf-8') }));
    },
  };
}

function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, 'utf-8') <= maxBytes) return body;
  const sliced = body.slice(0, maxBytes);
  return `${sliced}\n…(truncated to ${maxBytes} bytes)`;
}

// ─── Sources ──────────────────────────────────────────────────────

interface FindingRow {
  id: string;
  experiment_id: string;
  subject: string | null;
  summary: string;
  verdict: string;
  ran_at: string;
  evidence: unknown;
}

async function collectRecentFindings(
  db: DatabaseAdapter,
  windowHours: number,
  limit: number,
): Promise<ContextPackSection | null> {
  try {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    const res = await db
      .from<FindingRow>('self_findings')
      .select('id, experiment_id, subject, summary, verdict, ran_at, evidence')
      .gte('ran_at', since)
      .in('verdict', ['warning', 'fail'])
      .order('ran_at', { ascending: false })
      .limit(limit);
    const rows = ((res as { data?: FindingRow[] | null }).data ?? []) as FindingRow[];
    if (rows.length === 0) return null;
    const lines = rows.map((r) => {
      const subj = r.subject ?? '(no subject)';
      const summary = (r.summary ?? '').slice(0, 180);
      const files = extractAffectedFiles(r.evidence).slice(0, 3).join(', ');
      const suffix = files ? ` [${files}]` : '';
      return `  - [${r.verdict}] ${r.experiment_id} / ${subj}${suffix}: ${summary}`;
    });
    return {
      name: 'recent-findings',
      body: `Warning/fail findings from the last ${windowHours}h (newest first):\n${lines.join('\n')}`,
    };
  } catch (err) {
    logger.debug({ err }, '[context-pack] recent-findings source failed');
    return null;
  }
}

function collectRevenueGapFocus(): ContextPackSection | null {
  const focus = getRuntimeConfig<string | null>('strategy.revenue_gap_focus', null);
  const priorities = getRuntimeConfig<string[] | null>('strategy.revenue_gap_priorities', null);
  if (!focus && !Array.isArray(priorities)) return null;
  const lines: string[] = [];
  if (focus) lines.push(`Focus: ${focus}`);
  if (Array.isArray(priorities) && priorities.length > 0) {
    lines.push(`Priority experiments: ${priorities.join(', ')}`);
  }
  if (lines.length === 0) return null;
  return {
    name: 'revenue-gap-focus',
    body: lines.join('\n'),
  };
}

function collectAttributionFindings(): ContextPackSection | null {
  const blob = getRuntimeConfig<unknown>('strategy.attribution_findings', null);
  if (!blob || typeof blob !== 'object') return null;
  try {
    return {
      name: 'attribution-findings',
      body: JSON.stringify(blob, null, 2),
    };
  } catch {
    return null;
  }
}

interface GoalRow {
  id: string;
  title: string | null;
  target_metric: string | null;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  due_date: string | null;
}

async function collectActiveGoals(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<ContextPackSection | null> {
  try {
    const res = await db
      .from<GoalRow>('agent_workforce_goals')
      .select('id, title, target_metric, target_value, current_value, unit, due_date')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active');
    const rows = ((res as { data?: GoalRow[] | null }).data ?? []) as GoalRow[];
    if (rows.length === 0) return null;
    const lines = rows.slice(0, 10).map((g) => {
      const cur = Number(g.current_value ?? 0);
      const tgt = Number(g.target_value ?? 0);
      const pct = tgt > 0 ? ` (${Math.round((cur / tgt) * 100)}%)` : '';
      const due = g.due_date ? ` by ${g.due_date.slice(0, 10)}` : '';
      const unit = g.unit ? ` ${g.unit}` : '';
      return `  - '${g.title ?? g.id}' [${g.target_metric ?? '?'}]: ${cur}/${tgt}${unit}${pct}${due}`;
    });
    return {
      name: 'active-goals',
      body: `Active goals for this workspace:\n${lines.join('\n')}`,
    };
  } catch (err) {
    logger.debug({ err }, '[context-pack] active-goals source failed');
    return null;
  }
}

const REJECTION_NOTE_MAX_CHARS = 180;
const EMAIL_LOCALPART_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

async function collectOperatorRejections(
  approvalsJsonlPath: string | null,
  maxRows: number,
): Promise<ContextPackSection | null> {
  if (!approvalsJsonlPath) return null;
  let rows: ApprovalEntry[];
  try {
    rows = readApprovalRows(approvalsJsonlPath);
  } catch (err) {
    logger.debug({ err }, '[context-pack] rejection source failed');
    return null;
  }
  const rejected = rows
    .filter((r) => r.status === 'rejected')
    .sort((a, b) => (a.ratedAt ?? a.ts).localeCompare(b.ratedAt ?? b.ts))
    .slice(-maxRows);
  if (rejected.length === 0) return null;

  const lines: string[] = [];
  for (const r of rejected) {
    const kind = r.kind;
    const summary = (r.summary ?? '').slice(0, 120);
    const note = typeof r.notes === 'string' && r.notes.length > 0
      ? r.notes.replace(EMAIL_LOCALPART_RE, '[email]').slice(0, REJECTION_NOTE_MAX_CHARS)
      : '(no note)';
    lines.push(`  - [${kind}] "${summary}" → ${note}`);
  }
  const body = `Last ${rejected.length} operator rejections (oldest first). Use these to avoid repeated rejection patterns in outreach copy or proposal shape:\n${lines.join('\n')}`;
  // Second-pass redaction for anything the per-line strip missed.
  const { redacted } = redactForPrompt(body);
  return {
    name: 'operator-rejections',
    body: redacted,
  };
}

/**
 * Active priorities the operator has declared for this workspace. Read
 * from `<dataDir>/priorities/*.md`. Keeping this section at the TOP of
 * the pack signals "these are what the operator wants you to steer
 * toward" before the LLM sees anything else. Returns null for a
 * workspace with no active priorities or no priorities dir — both
 * indistinguishable from the reader's POV.
 */
function collectActivePriorities(dataDir: string | null): ContextPackSection | null {
  if (!dataDir) return null;
  try {
    const active = readActivePriorities(dataDir);
    if (active.length === 0) return null;
    const lines = active.map((p) => {
      const tags = p.tags.length > 0 ? ` tags=[${p.tags.join(', ')}]` : '';
      return `  - "${p.title}"${tags}\n    goal: ${firstParagraph(p.summary).slice(0, 200)}`;
    });
    return {
      name: 'active-priorities',
      body: `Operator-declared priorities the loop should steer toward this week. Prefer candidates whose experiment / subject / paths intersect a priority's tags; after a successful commit, append a work-log entry to the matching priority file:\n${lines.join('\n')}`,
    };
  } catch (err) {
    logger.debug({ err }, '[context-pack] active-priorities source failed');
    return null;
  }
}

function firstParagraph(summary: string): string {
  const stripped = summary.replace(/^##[^\n]*\n/gm, '').trim();
  const para = stripped.split(/\n\n+/)[0] ?? stripped;
  return para.replace(/\s+/g, ' ');
}

function collectRoadmapGaps(repoRoot: string | null): ContextPackSection | null {
  if (!repoRoot) return null;
  try {
    const body = fs.readFileSync(path.join(repoRoot, 'roadmap', 'gaps.md'), 'utf-8');
    const trimmed = body.trim();
    if (trimmed.length === 0) return null;
    const { redacted } = redactForPrompt(trimmed);
    return {
      name: 'roadmap-gaps',
      body: redacted,
    };
  } catch {
    return null;
  }
}

/**
 * Summarize the last N reverted autonomous patches so the model can
 * see "we already tried this shape and Layer 5 pulled it back." Keeps
 * the pre-flight filter's decision explicit in the prompt, which
 * nudges the author away from re-trying the same file/finding pair
 * with cosmetic variation. Returns null when the log has no revert
 * rows yet — a fresh workspace or a workspace that's never had a
 * reverted commit.
 */
async function collectPatchesAttempted(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<ContextPackSection | null> {
  try {
    const rows = await recentRevertedAttempts(db, workspaceId, 10);
    if (rows.length === 0) return null;
    const lines = rows.map((r) => {
      const sha = r.commitSha ? r.commitSha.slice(0, 12) : '?';
      const mode = r.patchMode ? ` [${r.patchMode}]` : '';
      return `  - ${r.proposedAt} sha=${sha}${mode} finding=${r.findingId.slice(0, 8)} file-hash=${r.fileHash.slice(0, 12)}`;
    });
    return {
      name: 'patches-attempted',
      body: `Recent reverted autonomous patches (newest first). Avoid re-proposing the same (finding, file-shape) tuples — Layer 5 already rolled them back:\n${lines.join('\n')}`,
    };
  } catch (err) {
    logger.debug({ err }, '[context-pack] patches-attempted source failed');
    return null;
  }
}

export function extractAffectedFiles(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== 'object') return [];
  const raw = (evidence as Record<string, unknown>).affected_files;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
}
