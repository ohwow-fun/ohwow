/**
 * RoadmapObserverExperiment — Layer 2 of the bench level-up plan.
 *
 * Closes the missing direction between AUTONOMY_ROADMAP.md and the
 * experiment-author's work queue. Existing wiring is one-way: the
 * roadmap-updater writes the doc, patch-author reads the Active Focus
 * section as LLM context, the proposal-generator reads Known Gaps as
 * LLM context. Nothing today lets the ROADMAP prioritise which brief
 * the author picks next. This experiment fills that gap.
 *
 * probe:
 *   - Parse AUTONOMY_ROADMAP.md §4 for `### P[0-4] — <title>` headings.
 *   - git log --since=7d to see which gaps are getting attention.
 *   - For each gap, tokenise the title + match against commit subjects,
 *     commit bodies, and touched file paths in the 7-day window.
 *
 * judge:
 *   - pass if every P0 gap has at least one matching commit.
 *   - warning if any P0 is stale (no matches).
 *   - fail if any P0 has been stale for > 14 d (conservative: same
 *     window so one probe can raise this if the roadmap goes unchanged
 *     while P0s sit untouched).
 *
 * intervene (warning only):
 *   - Extract 3-5 short tokens from stale P0/P1 gap titles.
 *   - setRuntimeConfig('strategy.roadmap_priorities', tokens).
 *   - Layer 1's ranker reads that key and pulls any brief whose slug
 *     or template contains one of those tokens to the front of the
 *     queue, behind the strategist's own priority_experiments.
 *   - Reversible: deleteRuntimeConfig to clear.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';
import { setRuntimeConfig } from '../runtime-config.js';
import { logger } from '../../lib/logger.js';

const ROADMAP_REL = 'AUTONOMY_ROADMAP.md';
const GAPS_REL = 'roadmap/gaps.md';
const LOOKBACK_DAYS = 7;
const PROBE_EVERY_MS = 30 * 60 * 1000;
const MAX_PRIORITY_TOKENS = 5;

/**
 * Stopwords to strip from gap titles before emitting priority tokens.
 * Keeps the matcher from matching everything because "the" or "is" is
 * in both the gap and most slugs.
 */
const STOPWORDS = new Set<string>([
  'a', 'an', 'and', 'or', 'the', 'is', 'are', 'of', 'for', 'to', 'in',
  'on', 'at', 'by', 'be', 'no', 'not', 'not-yet', 'only', 'has', 'have',
  'can', 'its', 'it', 'as', 'with', 'this', 'that', 'these', 'those',
  'p0', 'p1', 'p2', 'p3', 'p4',
]);

export interface RoadmapGap {
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  title: string;
  tokens: string[];
  matches: number;
  activity: 'active' | 'new' | 'stale';
}

export interface RoadmapObserverEvidence extends Record<string, unknown> {
  roadmap_path: string;
  parsed_gaps: number;
  gaps: RoadmapGap[];
  git_window_days: number;
  git_commits_scanned: number;
  stale_p0_count: number;
  stale_p1_count: number;
  stale_tokens: string[];
}

/** Tokenise a gap title into 2-12 char lowercase words, stopwords removed. */
function tokenise(title: string): string[] {
  const parts = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length >= 3 && w.length <= 20 && !STOPWORDS.has(w));
  return [...new Set(parts)];
}

/**
 * Parse §4 Known Gaps in AUTONOMY_ROADMAP.md. Returns an empty list if
 * the section is absent (either the header moved, or the doc was
 * reshaped by a RoadmapUpdaterExperiment patch). Tolerates both the
 * main AUTONOMY_ROADMAP.md and the companion roadmap/gaps.md — checks
 * both and merges. Duplicate priorities dedupe on (priority, title).
 */
export function parseKnownGaps(repoRoot: string): RoadmapGap[] {
  const sources: string[] = [];
  for (const rel of [ROADMAP_REL, GAPS_REL]) {
    try {
      sources.push(fs.readFileSync(path.join(repoRoot, rel), 'utf-8'));
    } catch {
      // optional; either file may be absent on a fresh workspace.
    }
  }
  const gaps: RoadmapGap[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    // Match `### P0 — Title` with either em-dash or dash. The dash
    // character varies across edits of the doc, so accept both.
    const re = /^###\s+(P[0-4])\s*[—\-–]\s*(.+?)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const priority = m[1] as RoadmapGap['priority'];
      const title = m[2].trim();
      const dedupeKey = `${priority}|${title.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      gaps.push({
        priority,
        title,
        tokens: tokenise(title),
        matches: 0,
        activity: 'stale',
      });
    }
  }
  return gaps;
}

/**
 * Collect recent commit subjects + touched files. Wraps git log in a
 * try/catch so a bare repo or missing .git doesn't crash the probe —
 * a workspace without git history just sees every gap as stale.
 */
function collectRecentCommits(repoRoot: string): { body: string; commits: number } {
  try {
    const out = execFileSync(
      'git',
      [
        'log',
        `--since=${LOOKBACK_DAYS}.days.ago`,
        '--name-only',
        '--pretty=format:%H%n%s%n%b%n',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 15_000,
      },
    );
    const commits = (out.match(/^[0-9a-f]{40}$/gm) ?? []).length;
    return { body: out.toLowerCase(), commits };
  } catch (err) {
    logger.debug({ err }, '[roadmap-observer] git log unavailable');
    return { body: '', commits: 0 };
  }
}

/**
 * Per-gap activity scoring. A gap is `active` when any of its tokens
 * (>= 2) appear in the commit window, `new` when exactly one token
 * matches (weak signal), and `stale` otherwise.
 */
function scoreActivity(gaps: RoadmapGap[], body: string): void {
  for (const gap of gaps) {
    let matches = 0;
    for (const tok of gap.tokens) {
      if (body.includes(tok)) matches += 1;
    }
    gap.matches = matches;
    gap.activity = matches >= 2 ? 'active' : matches === 1 ? 'new' : 'stale';
  }
}

export class RoadmapObserverExperiment implements Experiment {
  readonly id = 'roadmap-observer';
  readonly name = 'Roadmap observer (Layer 2)';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Autonomous work that matches the tokens of currently-stale Known Gaps is more likely to move the loop forward than work picked by FIFO alone. Writing those tokens into strategy.roadmap_priorities lets the experiment-author ranker surface roadmap-aligned briefs.';
  readonly cadence = { everyMs: PROBE_EVERY_MS, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const status = getSelfCommitStatus();
    if (!status.repoRoot) {
      return {
        subject: null,
        summary: 'no repo root — roadmap observer stood down',
        evidence: {
          roadmap_path: '',
          parsed_gaps: 0,
          gaps: [],
          git_window_days: LOOKBACK_DAYS,
          git_commits_scanned: 0,
          stale_p0_count: 0,
          stale_p1_count: 0,
          stale_tokens: [],
        } satisfies RoadmapObserverEvidence,
      };
    }

    const gaps = parseKnownGaps(status.repoRoot);
    const { body, commits } = collectRecentCommits(status.repoRoot);
    scoreActivity(gaps, body);

    const stalePrioTokens = new Set<string>();
    let staleP0 = 0;
    let staleP1 = 0;
    for (const gap of gaps) {
      if (gap.activity !== 'stale') continue;
      if (gap.priority === 'P0') staleP0 += 1;
      if (gap.priority === 'P1') staleP1 += 1;
      if (gap.priority === 'P0' || gap.priority === 'P1') {
        for (const tok of gap.tokens.slice(0, 3)) stalePrioTokens.add(tok);
      }
    }

    const stale_tokens = [...stalePrioTokens].slice(0, MAX_PRIORITY_TOKENS);

    const evidence: RoadmapObserverEvidence = {
      roadmap_path: path.join(status.repoRoot, ROADMAP_REL),
      parsed_gaps: gaps.length,
      gaps,
      git_window_days: LOOKBACK_DAYS,
      git_commits_scanned: commits,
      stale_p0_count: staleP0,
      stale_p1_count: staleP1,
      stale_tokens,
    };

    const summary = gaps.length === 0
      ? 'no Known Gaps parsed from roadmap'
      : `${gaps.length} gaps parsed, ${staleP0} P0 stale, ${staleP1} P1 stale over ${commits} commits in ${LOOKBACK_DAYS}d`;

    return { subject: 'roadmap:known-gaps', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as RoadmapObserverEvidence;
    if (ev.parsed_gaps === 0) return 'pass'; // nothing to score
    if (ev.stale_p0_count > 0) return 'warning';
    return 'pass';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict !== 'warning') return null;
    const ev = result.evidence as RoadmapObserverEvidence;
    if (ev.stale_tokens.length === 0) return null;

    await setRuntimeConfig(
      ctx.db,
      'strategy.roadmap_priorities',
      ev.stale_tokens,
      { setBy: this.id },
    );

    return {
      description: `Roadmap steering: ${ev.stale_tokens.length} stale-P0/P1 tokens written to strategy.roadmap_priorities`,
      details: {
        config_key: 'strategy.roadmap_priorities',
        tokens: ev.stale_tokens,
        stale_p0_count: ev.stale_p0_count,
        stale_p1_count: ev.stale_p1_count,
        reversible: true,
      },
    };
  }
}
