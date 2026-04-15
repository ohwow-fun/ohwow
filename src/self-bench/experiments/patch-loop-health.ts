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
import { getAllowedPrefixes, resolvePathTier } from '../path-trust-tiers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Minimum post-restart window before hold_rate / pool_delta signals
 * are treated as real. Below this, the 24h lookback mixes pre-restart
 * state (stale probes, dead patch attempts) with live state and the
 * verdict oscillates nonsensically. Verdict=warning with reason=warmup
 * until we have at least this much live data — warning signals
 * "unmeasured" to consumers, which is distinguishable from "healthy".
 */
const WARMUP_MS = 30 * 60 * 1000;

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
  readonly cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

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

    // Restart is a state boundary. If the runner recently started,
    // the 24h window is dominated by pre-restart artifacts (stranded
    // experiments, dead patch attempts). Emit warmup pass until we
    // have enough live data to judge.
    const now = Date.now();
    const uptimeMs = ctx.runnerStartedAtMs ? now - ctx.runnerStartedAtMs : DAY_MS;
    if (uptimeMs < WARMUP_MS) {
      const evidence: LoopHealthEvidence = {
        window_hours: Math.round((uptimeMs / (60 * 60 * 1000)) * 100) / 100,
        patches_landed: 0,
        patches_reverted: 0,
        patches_held: 0,
        hold_rate: null,
        violation_pool_today: 0,
        violation_pool_yesterday: 0,
        pool_delta: null,
        repo_root: repoRoot,
        reason: 'post_restart_warmup',
      };
      return {
        subject: 'meta:patch-loop-health',
        summary: `post-restart warmup (${Math.round(uptimeMs / 60000)}min of ${WARMUP_MS / 60000}min)`,
        evidence,
      };
    }

    // Floor the lookback at boot time so we never count patches or
    // findings from a prior daemon instance against the live loop.
    const windowMs = Math.min(DAY_MS, uptimeMs);
    const { landed, reverted } = scanGitLog(repoRoot, windowMs);
    const held = landed.length - reverted.size;
    const holdRate =
      landed.length > 0 ? held / landed.length : null;

    // pool_delta compares today vs yesterday (needs 48h history).
    // When uptime < 48h, the yesterday bucket is partially or fully
    // pre-restart — suppress the delta rather than emit noise.
    const { today, yesterday } = await countViolationPool(ctx, windowMs);
    const haveFullComparison = uptimeMs >= 2 * DAY_MS;
    const poolDelta = haveFullComparison ? today - yesterday : null;

    const evidence: LoopHealthEvidence = {
      window_hours: Math.round((windowMs / (60 * 60 * 1000)) * 100) / 100,
      patches_landed: landed.length,
      patches_reverted: reverted.size,
      patches_held: held,
      hold_rate: holdRate !== null ? Math.round(holdRate * 100) / 100 : null,
      violation_pool_today: today,
      violation_pool_yesterday: haveFullComparison ? yesterday : 0,
      pool_delta: poolDelta,
      repo_root: repoRoot,
    };

    const rateStr =
      holdRate !== null ? `hold_rate=${(holdRate * 100).toFixed(0)}%` : 'no patches';
    const poolStr =
      poolDelta === null
        ? `pool ${today} (no yesterday comparison)`
        : `pool ${today} (${poolDelta >= 0 ? '+' : ''}${poolDelta} vs yesterday)`;
    const summary = `${landed.length} landed, ${reverted.size} reverted — ${rateStr}; violation ${poolStr}`;

    return { subject: 'meta:patch-loop-health', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as LoopHealthEvidence;
    if (ev.reason === 'no_repo_root') return 'pass';
    // Warmup means "unmeasured", not "healthy". Report `warning` so
    // consumers (strategist, dashboards, cold-prompt readers) can
    // distinguish "loop is fine" from "I can't tell yet". Pass during
    // warmup makes the organ silently invisible after every restart.
    if (ev.reason === 'post_restart_warmup') return 'warning';
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
  todayWindowMs: number,
): Promise<{ today: number; yesterday: number }> {
  const now = Date.now();
  // Floor the "today" window at runner boot so pre-restart findings
  // never count as live violations.
  const todayStartMs = now - todayWindowMs;
  const todayStart = new Date(todayStartMs).toISOString();
  const yesterdayStart = new Date(todayStartMs - DAY_MS).toISOString();

  // Derive tier-2 prefixes from the authoritative registry so this
  // list stays in sync automatically when new paths are promoted.
  const TIER2_PREFIXES = getAllowedPrefixes().filter(
    (p) => resolvePathTier(p).tier === 'tier-2',
  );

  try {
    // Fetch findings for the 48h window newest-first so the 5000-row cap
    // keeps the most recent data rather than the oldest.
    const { data } = await ctx.db
      .from<{ id: string; verdict: string; ran_at: string; evidence: unknown }>(
        'self_findings',
      )
      .select('id, verdict, ran_at, evidence')
      .gte('ran_at', yesterdayStart)
      .order('ran_at', { ascending: false })
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
