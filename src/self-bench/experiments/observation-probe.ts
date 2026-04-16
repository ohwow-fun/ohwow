/**
 * ObservationProbeExperiment — auto-observer of the autonomous loop.
 *
 * Runs `assembleObservation` (see ../observation.ts) on a cadence so
 * every probe tick lands a snapshot in the ledger as a self_findings
 * row. The loop now observes itself: downstream experiments can key
 * off the `anomalies[].code` enumeration in evidence without re-
 * walking git + the DB themselves.
 *
 * This experiment intentionally has no intervene(). Anomalies it
 * detects are consumed by other experiments (e.g. a future
 * patch-author-novelty-cooldown experiment, or the strategist). The
 * observer's job is to produce a deterministic snapshot. Acting on
 * it is someone else's responsibility.
 *
 * Cadence: 10 minutes, runOnBoot: true. A 30-minute window per probe
 * means three consecutive snapshots overlap — that's intentional. A
 * state change that appears in two consecutive snapshots is durable;
 * one that appears in only one is a flicker.
 *
 * Verdict mapping:
 *   healthy   → pass     (loop is producing commits without reverts)
 *   quiet     → warning  (no autonomous activity in window)
 *   thrashing → fail     (>2 reverts in window)
 *   degraded  → fail     (any severity=error anomaly)
 */

import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import fs from 'node:fs';
import path from 'node:path';
import { getSelfCommitStatus } from '../self-commit.js';
import { workspaceLayoutFor } from '../../config.js';
import { logger } from '../../lib/logger.js';
import {
  assembleObservation,
  parseRankerEvidence,
  probeCommits,
  probePriorities,
  type DaemonReport,
  type FindingsReport,
  type Observation,
  type PatchesAttemptedReport,
  type RankerReport,
  THRESHOLDS,
} from '../observation.js';
import { ingestKnowledgeText } from '../knowledge-ingest.js';

const WINDOW_MINUTES = 30;
const PROBE_EVERY_MS = 10 * 60 * 1000;
/** Inside the daemon we skip the HTTP /health probe — if we're running, we're healthy. */
const IN_DAEMON_DAEMON: DaemonReport = {
  running: true,
  healthy: true,
  uptime_s: null,
  port: 0,
};
/**
 * Hard cap on rows pulled per in-window query. At 10k findings per
 * 30-min window the experiment can't afford to pull everything via
 * the adapter — probes are supposed to be cheap. The
 * `EXPERIMENT_FINDING_FLOOD` anomaly is therefore a CLI-only check
 * today; the in-daemon observer emits totals only.
 */
const MAX_FINDINGS_SCAN = 5000;

async function readPatchesAttempted(
  ctx: ExperimentContext,
  sinceIso: string,
): Promise<PatchesAttemptedReport> {
  const { data } = await ctx.db
    .from<{ outcome: string }>('patches_attempted_log')
    .select('outcome')
    .eq('workspace_id', ctx.workspaceId)
    .gt('proposed_at', sinceIso);
  const rows = (data ?? []) as Array<{ outcome: string }>;
  const byOutcome: Record<string, number> = { pending: 0, held: 0, reverted: 0 };
  for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  return { total: rows.length, by_outcome: byOutcome };
}

async function readFindings(
  ctx: ExperimentContext,
  sinceIso: string,
): Promise<FindingsReport> {
  const { data } = await ctx.db
    .from<{ experiment_id: string }>('self_findings')
    .select('experiment_id')
    .gt('ran_at', sinceIso)
    .order('ran_at', { ascending: false })
    .limit(MAX_FINDINGS_SCAN);
  const rows = (data ?? []) as Array<{ experiment_id: string }>;
  const byExperiment: Record<string, number> = {};
  for (const r of rows) byExperiment[r.experiment_id] = (byExperiment[r.experiment_id] ?? 0) + 1;
  const flooding = Object.entries(byExperiment)
    .filter(([, c]) => c > THRESHOLDS.EXPERIMENT_FINDING_FLOOD)
    .map(([experiment, count]) => ({ experiment, count }));
  return { total: rows.length, by_experiment: byExperiment, flooding_experiments: flooding };
}

async function readRanker(ctx: ExperimentContext): Promise<RankerReport> {
  const { data } = await ctx.db
    .from<{ ran_at: string; evidence: string }>('self_findings')
    .select('ran_at,evidence')
    .eq('experiment_id', 'patch-author')
    .order('ran_at', { ascending: false })
    .limit(1);
  const rows = (data ?? []) as Array<{ ran_at: string; evidence: string }>;
  const row = rows[0];
  return parseRankerEvidence(row?.ran_at ?? null, row?.evidence ?? null);
}

async function readRuntimeKeys(ctx: ExperimentContext): Promise<Set<string>> {
  const { data } = await ctx.db
    .from<{ key: string }>('runtime_config_overrides')
    .select('key');
  return new Set(((data ?? []) as Array<{ key: string }>).map((r) => r.key));
}

export class ObservationProbeExperiment implements Experiment {
  readonly id = 'observation-probe';
  readonly name = 'Autonomous-loop observer';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'A deterministic snapshot of the autonomous loop (commits, reverts, patches-attempted, ranker breakdown, priority state) written into self_findings on a fixed cadence lets other experiments key off enumerated anomaly codes instead of re-walking git + the DB themselves.';
  readonly cadence = { everyMs: PROBE_EVERY_MS, runOnBoot: true };

  /**
   * Intentionally no intervene. Anomalies this observer emits are
   * acted on by other experiments; the observer's job is pure
   * observation.
   */
  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const status = getSelfCommitStatus();
    const repoRoot = status.repoRoot;
    const now = new Date();
    const start = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
    const sinceIso = start.toISOString();
    const endIso = now.toISOString();
    const workspaceSlug = ctx.workspaceSlug ?? 'default';
    const dataDir = (() => {
      try {
        return workspaceLayoutFor(workspaceSlug).dataDir;
      } catch {
        return null;
      }
    })();

    if (!repoRoot) {
      logger.debug('[observation-probe] no repo root — stood down');
      return {
        subject: 'autonomous-loop-snapshot',
        summary: 'no repo root — observer stood down',
        evidence: { schema_version: 1, reason: 'no_repo_root' },
      };
    }

    const commits = probeCommits(repoRoot, sinceIso);
    const priorities = probePriorities(dataDir, sinceIso);
    const patches_attempted = await readPatchesAttempted(ctx, sinceIso);
    const findings = await readFindings(ctx, sinceIso);
    const ranker = await readRanker(ctx);
    const runtime_config_keys = await readRuntimeKeys(ctx);
    const sessionMarkerExists = fs.existsSync(path.join(repoRoot, '.git', 'ohwow-session-live'));

    const observation: Observation = assembleObservation({
      workspace: workspaceSlug,
      generated_at: endIso,
      window: {
        start: sinceIso,
        end: endIso,
        duration_s: Math.round((now.getTime() - start.getTime()) / 1000),
      },
      daemon: IN_DAEMON_DAEMON,
      commits,
      patches_attempted,
      findings,
      priorities,
      ranker,
      runtime_config_keys,
      session_marker_exists: sessionMarkerExists,
      skip_daemon_probe: true,
    });

    const errorAnomalies = observation.anomalies.filter((a) => a.severity === 'error');
    const warnAnomalies = observation.anomalies.filter((a) => a.severity === 'warn');
    const summary =
      `verdict=${observation.verdict} ` +
      `auton=${commits.autonomous} reverts=${commits.by_trailer['Auto-Reverts'] ?? 0} ` +
      `patches=${patches_attempted.total} ` +
      `err=${errorAnomalies.length} warn=${warnAnomalies.length}`;

    // Ingest this snapshot into the KB only when the anomaly signature
    // changes — consecutive "same state" snapshots would bloat the KB
    // and hurt search quality. The ledger (self_findings) still gets
    // a row per probe tick for full-fidelity timeseries; the KB gets
    // state transitions only. Smart-ingest principle: the KB is the
    // long-term memory, so it should remember changes, not heartbeats.
    if (await shouldIngestObservation(ctx, observation)) {
      const kbText = renderObservationForKb(observation);
      try {
        await ingestKnowledgeText(ctx.db, {
          workspaceId: ctx.workspaceId,
          title: `[self-observation] ${observation.verdict} @ ${observation.generated_at}`,
          text: kbText,
          sourceType: 'self-observation',
          sourceUrl: `ohwow://observation/${observation.generated_at}`,
          description: 'Autonomous-loop snapshot (observation-probe)',
        });
      } catch (err) {
        logger.debug({ err }, '[observation-probe] kb ingest failed; finding still written');
      }
    }

    return {
      subject: 'autonomous-loop-snapshot',
      summary,
      evidence: observation as unknown as Record<string, unknown>,
    };
  }

  /**
   * Always pass. The observation-probe *observes* the loop's health;
   * it never fails itself. Returning warning/fail on a quiet/degraded
   * loop state caused the adaptive scheduler to pull cadence in to
   * seconds (observed 15 firings in 2 minutes during live-run 2). The
   * actual "is the loop healthy?" signal lives in evidence.verdict and
   * evidence.anomalies; downstream experiments key off those, not the
   * judge output. Keeping this probe's judge at pass means the runner
   * respects its 10-minute cadence and lets the observation keep its
   * sampling integrity.
   */
  judge(_result: ProbeResult, _history: Finding[]): Verdict {
    return 'pass';
  }

  /**
   * Opting out of the runner's burn-down heuristic. `commits.total`,
   * `patches_attempted.total`, etc. naturally fluctuate — a drop is
   * not progress. Explicit opt-out prevents the auto-followup
   * validator from flagging every new snapshot as regression.
   */
  readonly burnDownKeys: string[] = [];
}

function observationSignature(obs: Observation): string {
  // verdict + sorted anomaly codes. Two snapshots with the same
  // signature are semantically the "same state" for KB purposes —
  // absolute counts can drift (findings keep accumulating) without
  // adding information to the knowledge layer.
  return `${obs.verdict}|${obs.anomalies.map((a) => a.code).sort().join(',')}`;
}

async function shouldIngestObservation(
  ctx: ExperimentContext,
  current: Observation,
): Promise<boolean> {
  const { data } = await ctx.db
    .from<{ evidence: string }>('self_findings')
    .select('evidence')
    .eq('experiment_id', 'observation-probe')
    .order('ran_at', { ascending: false })
    .limit(1);
  const rows = (data ?? []) as Array<{ evidence: string }>;
  if (rows.length === 0) return true; // first snapshot — always ingest
  try {
    const prev = JSON.parse(rows[0].evidence) as Observation;
    if (!prev.anomalies) return true; // malformed → ingest to be safe
    return observationSignature(prev) !== observationSignature(current);
  } catch {
    return true;
  }
}

/**
 * Convert an Observation to natural-language text for KB ingestion.
 * Keeps the shape stable so BM25 + semantic search hit the same keys
 * across snapshots: "verdict:", "reverts:", enumerated anomaly codes,
 * etc. Rule 5 of the proposal generator (Tier 3) can then pull a
 * readable history with a single searchKnowledge call instead of
 * parsing the raw evidence JSON.
 */
function renderObservationForKb(obs: Observation): string {
  const lines: string[] = [];
  lines.push(`Autonomous-loop snapshot at ${obs.generated_at} (workspace=${obs.workspace}).`);
  lines.push(`Verdict: ${obs.verdict}.`);
  lines.push(
    `Window: ${obs.window.start} → ${obs.window.end} (${Math.round(obs.window.duration_s / 60)} min).`,
  );
  lines.push(
    `Commits: ${obs.commits.total} total, ${obs.commits.autonomous} autonomous, ${
      obs.commits.by_trailer['Auto-Reverts'] ?? 0
    } reverts, ${obs.commits.by_trailer['Cites-Sales-Signal'] ?? 0} cite sales signal, ${
      obs.commits.by_trailer['Cites-Research-Paper'] ?? 0
    } cite research paper.`,
  );
  lines.push(
    `Patches attempted: ${obs.patches_attempted.total} total (${Object.entries(obs.patches_attempted.by_outcome).map(([k, v]) => `${v} ${k}`).join(', ')}).`,
  );
  lines.push(
    `Priorities: ${obs.priorities.active_slugs.length} active (${obs.priorities.active_slugs.join(', ') || 'none'}), ${obs.priorities.pending_slugs.length} pending.`,
  );
  if (obs.ranker.last_ran_at) {
    const novel = obs.ranker.novelty?.repeat_count ?? 0;
    lines.push(
      `Patch-author ranker: last ran ${obs.ranker.last_ran_at}, top_pick ${
        obs.ranker.top_pick ? 'present' : 'null'
      }, novelty repeat_count=${novel}.`,
    );
  }
  if (obs.anomalies.length > 0) {
    lines.push('Anomalies detected:');
    for (const a of obs.anomalies) {
      lines.push(`  - [${a.severity}] ${a.code}: ${a.detail || '(no detail)'}`);
    }
  } else {
    lines.push('Anomalies: none.');
  }
  return lines.join('\n');
}
