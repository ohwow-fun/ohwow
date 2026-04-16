/**
 * GitVelocityExperiment — Layer 3 of the bench level-up plan.
 *
 * Observer-only. Reads `git log --since=24h --stat` and groups the
 * touched files by top-level directory, then splits each bucket into
 * autonomous-authored vs human-authored commits. The resulting snapshot
 * is the first per-subsystem awareness signal the loop has ever had.
 *
 * It does NOT intervene. Other experiments (the roadmap observer, the
 * strategist, a future subsystem-health probe) can read these findings
 * via `ctx.recentFindings('git-velocity')` to know which subsystems are
 * under active development and which are stagnant.
 *
 * Why we split autonomous vs human commits: the former are
 * identified by the "Self-authored by experiment:" trailer. An hour
 * with 20 autonomous commits and 0 human commits tells a different
 * story than an hour with 1 human commit and 0 autonomous — the
 * former may be a regression loop, the latter is ordinary manual work.
 *
 * Cadence 15 minutes so the picture stays current without repeatedly
 * invoking git on every 2-minute tick of the proposal generator.
 */

import { execFileSync } from 'node:child_process';
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

const LOOKBACK_HOURS = 24;
const PROBE_EVERY_MS = 15 * 60 * 1000;

/**
 * Top-level buckets the velocity rollup uses. Anything outside this
 * set rolls into `other`. Keeping the list explicit (vs a regex) makes
 * the evidence schema stable across file-tree reshuffles, which
 * matters because downstream experiments (roadmap observer, future
 * strategist) pattern-match on these keys.
 */
const SUBSYSTEM_PREFIXES = [
  'src/orchestrator/',
  'src/self-bench/',
  'src/tui/',
  'src/web/',
  'src/lib/',
  'src/execution/',
  'src/db/',
  'src/scheduling/',
  'src/triggers/',
  'src/peers/',
  'src/integrations/',
  'src/api/',
  'src/mcp-server/',
  'src/mcp/',
  'scripts/',
  'roadmap/',
];

export interface SubsystemVelocity {
  subsystem: string;
  commits_total: number;
  commits_autonomous: number;
  commits_human: number;
  files_changed: number;
}

export interface GitVelocityEvidence extends Record<string, unknown> {
  window_hours: number;
  commits_total: number;
  commits_autonomous: number;
  commits_human: number;
  autonomous_ratio: number;
  subsystems: SubsystemVelocity[];
  top_subsystem: string | null;
  top_subsystem_commits: number;
}

interface ParsedCommit {
  sha: string;
  subject: string;
  autonomous: boolean;
  files: string[];
}

/**
 * Parse the output of
 *   git log --since=... --name-only --pretty=format:%H%n%s%n%b%n--EOC--
 *
 * git emits each commit as:
 *   <sha>
 *   <subject>
 *   <body lines...>
 *   --EOC--
 *   <file path lines...>
 *   <blank line>
 * and then the next commit. The --EOC-- marker cleanly terminates the
 * body (so a multi-line body doesn't get mis-tokenised as files) but the
 * file list that follows belongs to the same commit.
 *
 * Strategy: split once on the SHA anchor (every line matching
 * /^[0-9a-f]{40}$/ starts a new record), then within each record split
 * on --EOC-- to separate (subject + body) from (file list).
 */
export function parseGitLog(raw: string): ParsedCommit[] {
  if (!raw.trim()) return [];
  const lines = raw.split('\n');
  const records: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      if (current.length > 0) records.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) records.push(current);

  const commits: ParsedCommit[] = [];
  for (const rec of records) {
    const sha = rec[0];
    const eocIdx = rec.indexOf('--EOC--');
    const headerLines = eocIdx >= 0 ? rec.slice(1, eocIdx) : rec.slice(1);
    const subject = headerLines[0] ?? '';
    const body = headerLines.slice(1).join('\n');
    const files = eocIdx >= 0
      ? rec.slice(eocIdx + 1).filter((l) => l.length > 0)
      : [];
    const autonomous = /Self-authored by experiment:/m.test(body);
    commits.push({ sha, subject, autonomous, files });
  }
  return commits;
}

/**
 * Roll up parsed commits into per-subsystem buckets. A commit that
 * touches files in multiple subsystems counts once toward each one —
 * fair because one subsystem's velocity should not be muted by a
 * co-occurring change in another.
 */
export function rollUpByBucket(commits: ParsedCommit[]): SubsystemVelocity[] {
  const buckets = new Map<string, SubsystemVelocity>();
  const ensure = (name: string): SubsystemVelocity => {
    let row = buckets.get(name);
    if (!row) {
      row = { subsystem: name, commits_total: 0, commits_autonomous: 0, commits_human: 0, files_changed: 0 };
      buckets.set(name, row);
    }
    return row;
  };
  for (const c of commits) {
    const subsystemsHit = new Set<string>();
    for (const file of c.files) {
      const prefix = SUBSYSTEM_PREFIXES.find((p) => file.startsWith(p)) ?? 'other';
      subsystemsHit.add(prefix);
      const row = ensure(prefix);
      row.files_changed += 1;
    }
    if (subsystemsHit.size === 0) {
      subsystemsHit.add('other');
      ensure('other');
    }
    for (const s of subsystemsHit) {
      const row = ensure(s);
      row.commits_total += 1;
      if (c.autonomous) row.commits_autonomous += 1;
      else row.commits_human += 1;
    }
  }
  return [...buckets.values()].sort((a, b) => b.commits_total - a.commits_total);
}

function collectGitLog(repoRoot: string): { commits: ParsedCommit[]; raw: string } {
  try {
    const raw = execFileSync(
      'git',
      [
        'log',
        `--since=${LOOKBACK_HOURS}.hours.ago`,
        '--name-only',
        '--pretty=format:%H%n%s%n%b%n--EOC--',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: 15_000,
      },
    );
    return { commits: parseGitLog(raw), raw };
  } catch (err) {
    logger.debug({ err }, '[git-velocity] git log unavailable');
    return { commits: [], raw: '' };
  }
}

export class GitVelocityExperiment implements Experiment {
  readonly id = 'git-velocity';
  readonly name = 'Git velocity (Layer 3)';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Per-subsystem commit velocity, split autonomous vs human, is a durable awareness signal for the rest of the bench — RoadmapObserver, strategist, and future subsystem-health probes all benefit from knowing which areas are hot versus stagnant without each re-parsing git log.';
  readonly cadence = { everyMs: PROBE_EVERY_MS, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const status = getSelfCommitStatus();
    if (!status.repoRoot) {
      const evidence: GitVelocityEvidence = {
        window_hours: LOOKBACK_HOURS,
        commits_total: 0,
        commits_autonomous: 0,
        commits_human: 0,
        autonomous_ratio: 0,
        subsystems: [],
        top_subsystem: null,
        top_subsystem_commits: 0,
      };
      return { subject: null, summary: 'no repo root — git-velocity stood down', evidence };
    }

    const { commits } = collectGitLog(status.repoRoot);
    const subsystems = rollUpByBucket(commits);
    const autonomous = commits.filter((c) => c.autonomous).length;
    const human = commits.length - autonomous;
    const top = subsystems[0] ?? null;

    const evidence: GitVelocityEvidence = {
      window_hours: LOOKBACK_HOURS,
      commits_total: commits.length,
      commits_autonomous: autonomous,
      commits_human: human,
      autonomous_ratio: commits.length === 0 ? 0 : autonomous / commits.length,
      subsystems,
      top_subsystem: top ? top.subsystem : null,
      top_subsystem_commits: top ? top.commits_total : 0,
    };

    const summary = commits.length === 0
      ? `no commits in last ${LOOKBACK_HOURS}h`
      : `${commits.length} commits (${autonomous} autonomous / ${human} human) across ${subsystems.length} subsystem(s); top: ${top?.subsystem ?? '-'}`;

    return { subject: 'git:velocity-24h', summary, evidence };
  }

  judge(_result: ProbeResult, _history: Finding[]): Verdict {
    // Awareness probe; there is no "correct" velocity. Always pass so
    // the ledger row is present but the row doesn't wake a patch-author.
    return 'pass';
  }
}
