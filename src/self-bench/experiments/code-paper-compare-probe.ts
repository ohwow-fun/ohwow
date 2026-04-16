/**
 * CodePaperCompareProbeExperiment — paper ↔ codebase gap detector.
 *
 * For each recent arXiv paper in the workspace's KB, extract concept
 * tokens from title + abstract, then grep the workspace's repo to
 * see which concepts already exist and which are gaps. Emits a
 * finding per paper with `gap_concepts: string[]` — the actionable
 * signal for downstream proposals.
 *
 * Per-workspace boundary: reads its own KB (workspace_id filter) and
 * its own repo_root (via getSelfCommitStatus, which was pinned by
 * the daemon on boot — either from workspace.json.repoRoot or the
 * cwd-derived default). Never crosses workspaces.
 *
 * Deterministic today (no LLM call in the extractor). A future pass
 * can swap in a cheap LLM concept extractor; the contract stays the
 * same because the downstream consumer (Rule 5 prompt) keys off
 * `gap_concepts` as a string array.
 *
 * Cadence: 30 minutes, runOnBoot: true. Cheap probe (N grep calls
 * against the repo) — fine to run on every boot.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';
import { logger } from '../../lib/logger.js';

const PROBE_EVERY_MS = 30 * 60 * 1000;
/** How many recent arXiv KB rows to compare each tick. Larger = more coverage, more grep calls. */
const PAPERS_PER_TICK = 5;
/** Upper bound on concept tokens per paper. Extractor caps here. */
const CONCEPTS_PER_PAPER = 4;
/** Minimum token length to consider — below this is noise. */
const MIN_TOKEN_CHARS = 4;
/** Generic stopwords + academic-abstract boilerplate. Extend as we learn. */
const STOPWORDS = new Set<string>([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'from',
  'into', 'over', 'under', 'such', 'than', 'then', 'when', 'where', 'while',
  'between', 'through', 'against', 'across', 'about', 'after', 'before',
  'paper', 'present', 'propose', 'introduce', 'approach', 'method', 'methods',
  'model', 'models', 'result', 'results', 'show', 'shown', 'shows', 'using',
  'based', 'baseline', 'proposed', 'algorithm', 'framework', 'system',
  'study', 'studies', 'analysis', 'evaluation', 'experiment', 'experiments',
  'performance', 'accuracy', 'problem', 'problems', 'task', 'tasks',
  'work', 'works', 'used', 'use', 'data', 'dataset', 'datasets',
  'state-of-the-art', 'via', 'also', 'both', 'more', 'most', 'many', 'much',
  'our', 'their', 'they', 'them', 'its', 'have', 'has', 'had', 'been',
  'which', 'what', 'who', 'one', 'two', 'three', 'are', 'is',
]);

export interface CodePaperComparisonEntry {
  paper_id: string;
  title: string;
  concepts: string[];
  /** For each concept, number of matching files in the repo. */
  hit_counts: Record<string, number>;
  /** Concepts with zero hits in the repo — the actionable gap. */
  gap_concepts: string[];
  /** Ratio of concepts that had zero hits; 1.0 = total gap, 0.0 = full coverage. */
  gap_ratio: number;
}

export interface CodePaperCompareEvidence extends Record<string, unknown> {
  workspace: string;
  repo_root: string | null;
  papers_scanned: number;
  entries: CodePaperComparisonEntry[];
  /** Aggregate gap tokens across all papers this tick (deduped, sorted by frequency). */
  aggregate_gap_tokens: Array<{ token: string; papers: number }>;
}

/**
 * Extract concept tokens from a title + abstract. Naïve but deterministic:
 *   - tokenise on non-letter boundaries, lowercase
 *   - drop stopwords and short tokens
 *   - fold common morphology (-s, -ed, -ing) to stems via basic rules
 *   - rank by frequency (in-document) and take the top N
 * This is explicitly NOT a great NLP extractor. It's good enough to
 * seed ripgrep queries against the repo. Swap for an LLM pass later
 * if the signal-to-noise bottoms out.
 */
export function extractConcepts(text: string, max: number = CONCEPTS_PER_PAPER): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z-]+/)) {
    if (raw.length < MIN_TOKEN_CHARS) continue;
    // Fold common suffixes so "bandits" matches "bandit" in code.
    const token = raw
      .replace(/ing$/, '')
      .replace(/ies$/, 'y')
      .replace(/ed$/, '')
      .replace(/s$/, '');
    if (token.length < MIN_TOKEN_CHARS) continue;
    if (STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}

async function readRecentArxiv(
  ctx: ExperimentContext,
  limit: number,
): Promise<Array<{ paper_id: string; title: string; text: string }>> {
  const { data } = await ctx.db
    .from<{ title: string; compiled_text: string | null; source_url: string | null }>(
      'agent_workforce_knowledge_documents',
    )
    .select('title, compiled_text, source_url')
    .eq('workspace_id', ctx.workspaceId)
    .eq('source_type', 'arxiv')
    .order('created_at', { ascending: false })
    .limit(limit);
  const rows = (data ?? []) as Array<{
    title: string;
    compiled_text: string | null;
    source_url: string | null;
  }>;
  return rows.map((r) => ({
    paper_id: r.source_url?.split('/').pop() ?? 'unknown',
    title: r.title,
    text: `${r.title}\n${r.compiled_text ?? ''}`,
  }));
}

/** Directories we skip while walking the repo. Matches typical build + VCS trees. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', '.cache', 'coverage']);
/** File extensions we consider worth searching. Keeps the walk bounded. */
const INDEXED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java',
  '.md', '.mdx', '.sql',
  '.json', '.yaml', '.yml',
]);
/** Per-probe cap on files read so one call can't chew through a 50k-file repo. */
const MAX_FILES_SCANNED = 4000;
/** Per-file byte cap. Avoids slurping 50MB data files into memory. */
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Count files under `repoRoot` whose content (case-insensitive) contains
 * every `token`. Pure node — no ripgrep dependency — so the probe runs
 * identically in dev, CI, and test without external tools. Returns one
 * count per token in the same order.
 *
 * Single-pass walk for N tokens instead of one walk per token — the
 * bottleneck is reading files, not string matching, so amortising the
 * walk pays off for the typical N=4 concepts.
 */
function countRepoHitsForTokens(repoRoot: string, tokens: string[]): number[] {
  const counts = new Array(tokens.length).fill(0);
  const loweredTokens = tokens.map((t) => t.toLowerCase());
  let scanned = 0;

  function walk(dir: string): void {
    if (scanned >= MAX_FILES_SCANNED) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= MAX_FILES_SCANNED) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!INDEXED_EXTS.has(ext)) continue;
      scanned += 1;
      let content: string;
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(full, 'utf8').toLowerCase();
      } catch {
        continue;
      }
      for (let i = 0; i < loweredTokens.length; i++) {
        if (content.includes(loweredTokens[i])) counts[i] += 1;
      }
    }
  }
  walk(repoRoot);
  return counts;
}

export class CodePaperCompareProbeExperiment implements Experiment {
  readonly id = 'code-paper-compare-probe';
  readonly name = 'Paper ↔ codebase gap detector';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'A paper whose concepts are entirely absent from the workspace\'s repo is a better candidate for an authored experiment than a paper whose concepts are already richly represented in existing code. Surfacing gap_concepts lets the proposal LLM target techniques ohwow hasn\'t yet tried.';
  readonly cadence = { everyMs: PROBE_EVERY_MS, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const status = getSelfCommitStatus();
    const repoRoot = status.repoRoot;
    const workspaceSlug = ctx.workspaceSlug ?? 'default';

    if (!repoRoot) {
      return {
        subject: 'paper-code-compare',
        summary: 'no repo root resolved — probe stood down',
        evidence: { workspace: workspaceSlug, repo_root: null, papers_scanned: 0, entries: [], aggregate_gap_tokens: [] },
      };
    }

    const papers = await readRecentArxiv(ctx, PAPERS_PER_TICK);
    const entries: CodePaperComparisonEntry[] = [];
    const gapFrequency = new Map<string, number>();

    for (const paper of papers) {
      const concepts = extractConcepts(paper.text);
      const hitCounts: Record<string, number> = {};
      const gaps: string[] = [];
      const counts = concepts.length > 0 ? countRepoHitsForTokens(repoRoot, concepts) : [];
      for (let i = 0; i < concepts.length; i++) {
        const c = concepts[i];
        const n = counts[i];
        hitCounts[c] = n;
        if (n === 0) {
          gaps.push(c);
          gapFrequency.set(c, (gapFrequency.get(c) ?? 0) + 1);
        }
      }
      const gapRatio = concepts.length === 0 ? 0 : gaps.length / concepts.length;
      entries.push({
        paper_id: paper.paper_id,
        title: paper.title,
        concepts,
        hit_counts: hitCounts,
        gap_concepts: gaps,
        gap_ratio: gapRatio,
      });
    }

    const aggregate = [...gapFrequency.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([token, papers]) => ({ token, papers }));

    const evidence: CodePaperCompareEvidence = {
      workspace: workspaceSlug,
      repo_root: repoRoot,
      papers_scanned: papers.length,
      entries,
      aggregate_gap_tokens: aggregate,
    };

    const fullGapPapers = entries.filter((e) => e.gap_ratio === 1 && e.concepts.length > 0).length;
    const summary =
      papers.length === 0
        ? 'no arXiv papers in KB yet'
        : `scanned ${papers.length} paper(s); ${fullGapPapers} with full concept gap; top unresolved token: ${aggregate[0]?.token ?? 'none'}`;

    logger.debug(
      { workspace: workspaceSlug, papers: papers.length, fullGapPapers },
      '[code-paper-compare] probe complete',
    );

    return { subject: 'paper-code-compare', summary, evidence: evidence as unknown as Record<string, unknown> };
  }

  /**
   * Always pass. The comparison itself never fails — it reports on
   * coverage; action is owned by Rule 5 / experiment-author. Matches
   * the observation-probe pattern (same reason: avoid the runner's
   * REACTIVE_RESCHEDULE_MS pulling cadence into seconds).
   */
  judge(_result: ProbeResult, _history: Finding[]): Verdict {
    return 'pass';
  }

  readonly burnDownKeys: string[] = [];
}
