/**
 * PatchLoopHealthExperiment — convergence health monitor for the
 * autonomous tier-2 patch loop.
 *
 * The autonomous patch pipeline (PatchAuthorExperiment + Layer 5
 * rollback watcher) is self-correcting, but "self-correcting" can
 * mean either "converging toward zero violations" or "oscillating
 * patch→revert→patch→revert indefinitely." These look identical from
 * inside individual experiments.
 *
 * This experiment measures the loop from outside, aggregating across
 * all autonomous commits in a 24h window:
 *
 *   hold_rate  = (patches_landed - patches_reverted) / patches_landed
 *   pool_delta = active_violation_findings_today - yesterday
 *
 * Verdict:
 *   pass    — hold_rate ≥ 0.80 OR no patches landed (nothing to judge)
 *   warning — hold_rate 0.50–0.79 (patches landing faster than reverts;
 *             acceptable early-learning state)
 *   fail    — hold_rate < 0.50 (more than half of patches are being
 *             reverted — the loop is thrashing; escalate to operator)
 *
 * No intervene — this experiment is strictly observational. It provides
 * the signal that would trigger a human (or future meta-experiment) to
 * pause the patch-author loop via the kill switch.
 *
 * Probe is pure-read: git log + self_findings queries. Safe to run on
 * a live repo at any frequency. Set at 30min so we get ~48 data points
 * per day without thrashing the git subprocess.
 */

import { execSync } from 'node:child_process';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface PatchRecord {
  sha: string;
  ts: string;
  findingId: string;
  files: string[];
}

interface LoopHealthEvidence extends Record<string, unknown> {
  window_hours: number;
  patches_landed: number;
  patches_reverted: number;
  patches_held: number;
  hold_rate: number | null;
  /** Active warning|fail findings with tier-2 affected_files today. */
  violation_pool_today: number;
  /** Same metric 24h earlier (from findings ranAt 24-48h ago). */
  violation_pool_yesterday: number;
  pool_delta: number | null;
  repo_root: string | null;
  reason?: string;
}

export class PatchLoopHealthExperiment implements Experiment {
  readonly id = 'patch-loop-health';
  readonly name = 'Autonomous patch loop convergence monitor';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'The autonomous patch loop should be converging: patches should hold ' +
    'more often than they are reverted (hold_rate > 0.5), and the active ' +
    'violation pool should be trending down or stable over a 24h window.';
  readonly cadence = { everyMs: 30 * 60 * 1000, runOnBoot: false };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();

    if (!repoRoot) {
      const evidence: LoopHealthEvidence = {
        window_hours: 24,
        patches_landed: 0,
        patches_reverted: 0,
        patches_held: 0,
        hold_rate: null,
        violation_pool_today: 0,
        violation_pool_yesterday: 0,
        pool_delta: null,
        repo_root: null,
        reason: 'no_repo_root',
      };
      return {
        subject: 'meta:patch-loop-health',
        summary: 'no repo root configured — skipping',
        evidence,
      };
    }

    const { landed, reverted } = scanGitLog(repoRoot, DAY_MS);
    const held = landed.length - reverted.size;
    const holdRate =
      landed.length > 0 ? held / landed.length : null;

    const { today, yesterday } = await countViolationPool(ctx);
    const poolDelta = today - yesterday;

    const evidence: LoopHealthEvidence = {
      window_hours: 24,
      patches_landed: landed.length,
      patches_reverted: reverted.size,
      patches_held: held,
      hold_rate: holdRate !== null ? Math.round(holdRate * 100) / 100 : null,
      violation_pool_today: today,
      violation_pool_yesterday: yesterday,
      pool_delta: poolDelta,
      repo_root: repoRoot,
    };

    const rateStr =
      holdRate !== null ? `hold_rate=${(holdRate * 100).toFixed(0)}%` : 'no patches';
    const poolStr = `pool ${today} (${poolDelta >= 0 ? '+' : ''}${poolDelta} vs yesterday)`;
    const summary = `${landed.length} landed, ${reverted.size} reverted — ${rateStr}; violation ${poolStr}`;

    return { subject: 'meta:patch-loop-health', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as LoopHealthEvidence;
    if (ev.reason === 'no_repo_root') return 'pass';
    if (ev.hold_rate === null) return 'pass'; // no patches in window
    if (ev.hold_rate < 0.5) return 'fail';
    if (ev.hold_rate < 0.8) return 'warning';
    return 'pass';
  }
}

/**
 * Scan git log for the last `windowMs` and return:
 *   landed  — all autonomous commits carrying Fixes-Finding-Id
 *   reverted — set of shas that have been auto-reverted
 */
function scanGitLog(
  repoRoot: string,
  windowMs: number,
): { landed: PatchRecord[]; reverted: Set<string> } {
  const sinceSeconds = Math.ceil(windowMs / 1000);
  let raw: string;
  try {
    raw = execSync(
      `git log --since=${sinceSeconds}.seconds.ago --pretty=format:%H%x1f%aI%x1f%B%x1e`,
      { cwd: repoRoot, encoding: 'utf-8', timeout: 30_000 },
    );
  } catch {
    return { landed: [], reverted: new Set() };
  }

  const records = raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  // First pass: collect reverted shas from Auto-Reverts: trailers.
  const revertedShas = new Set<string>();
  for (const rec of records) {
    const parts = rec.split('\x1f');
    const body = parts[2] ?? '';
    const m = body.match(/^Auto-Reverts:\s*([0-9a-f]{7,40})\s*$/m);
    if (m?.[1]) revertedShas.add(m[1]);
  }

  // Second pass: collect autonomous patch commits.
  const landed: PatchRecord[] = [];
  for (const rec of records) {
    const [sha, ts, body] = rec.split('\x1f');
    if (!sha || !ts || !body) continue;
    const fixMatch = body.match(/^Fixes-Finding-Id:\s*([^\s]+)\s*$/m);
    if (!fixMatch) continue;
    let files: string[] = [];
    try {
      const filesOut = execSync(
        `git show --name-only --pretty=format: ${sha}`,
        { cwd: repoRoot, encoding: 'utf-8', timeout: 10_000 },
      );
      files = filesOut.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    } catch { /* ignore */ }
    landed.push({ sha, ts, findingId: fixMatch[1], files });
  }

  // Normalize reverted set: some Auto-Reverts: trailers use short shas.
  // Expand by matching prefix against landed shas.
  const expandedReverted = new Set<string>();
  for (const short of revertedShas) {
    // Exact match first.
    if (revertedShas.has(short)) expandedReverted.add(short);
    // Prefix match for short shas.
    for (const p of landed) {
      if (p.sha.startsWith(short)) expandedReverted.add(p.sha);
    }
  }

  return { landed, reverted: expandedReverted };
}

/**
 * Count active warning|fail findings with recent ran_at, bucketed into
 * "today" (last 24h) and "yesterday" (24-48h ago). Used to measure
 * whether the violation pool is growing, shrinking, or stable.
 *
 * "Active violation" = any finding with verdict warning|fail and
 * evidence.affected_files containing at least one tier-2 path prefix.
 * We don't import resolvePathTier here to keep this experiment lean;
 * instead we use a simple string prefix check against the known
 * tier-2 prefixes.
 */
async function countViolationPool(
  ctx: ExperimentContext,
): Promise<{ today: number; yesterday: number }> {
  const now = Date.now();
  const todayStart = new Date(now - DAY_MS).toISOString();
  const yesterdayStart = new Date(now - 2 * DAY_MS).toISOString();

  const TIER2_PREFIXES = [
    'src/lib/format-duration.ts',
    'src/lib/token-similarity.ts',
    'src/lib/stagnation.ts',
    'src/lib/error-classification.ts',
    'src/web/src/pages/',
  ];

  try {
    // Fetch findings for the 48h window in one query.
    const { data } = await ctx.db
      .from<{ id: string; verdict: string; ran_at: string; evidence: unknown }>(
        'self_findings',
      )
      .select('id, verdict, ran_at, evidence')
      .gte('ran_at', yesterdayStart)
      .limit(5000);

    const rows = (data ?? []) as Array<{
      id: string;
      verdict: string;
      ran_at: string;
      evidence: unknown;
    }>;

    let today = 0;
    let yesterday = 0;

    for (const row of rows) {
      if (row.verdict !== 'warning' && row.verdict !== 'fail') continue;
      if (!hasTier2AffectedFile(row.evidence, TIER2_PREFIXES)) continue;
      if (row.ran_at >= todayStart) {
        today++;
      } else {
        yesterday++;
      }
    }

    return { today, yesterday };
  } catch {
    return { today: 0, yesterday: 0 };
  }
}

function hasTier2AffectedFile(evidence: unknown, prefixes: string[]): boolean {
  if (!evidence || typeof evidence !== 'object') return false;
  const raw = (evidence as Record<string, unknown>).affected_files;
  if (!Array.isArray(raw)) return false;
  for (const f of raw) {
    if (typeof f !== 'string') continue;
    const normalized = f.replace(/\\/g, '/');
    if (prefixes.some((p) => normalized.startsWith(p) || normalized === p)) {
      return true;
    }
  }
  return false;
}
