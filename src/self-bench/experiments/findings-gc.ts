/**
 * FindingsGcExperiment — keep self_findings + experiment_validations
 * lean under fast-cadence probing.
 *
 * Why this exists
 * ---------------
 * The reactive-reschedule path in ExperimentRunner pulls warning/fail
 * probes back to a 5-second cadence so the loop reacts in near-real-
 * time. That's intentional. The side effect is that experiments whose
 * warnings are persistent (test-coverage-probe, agent-coverage-gap,
 * intervention-audit, source-copy-lint, ...) write a finding row every
 * ~10s indefinitely.
 *
 * supersedeDuplicates marks older same-shape rows status='superseded'
 * inside a 10-min window — but it never deletes anything, and it bails
 * out when subject is null (large classes of summary-only findings).
 * So the table grows without bound. A measurement at the time this
 * experiment was authored: 137,081 rows, 412.6MB of evidence JSON,
 * 60% of rows already flagged superseded.
 *
 * What this does
 * --------------
 * Every 10 minutes (and on boot) it hard-deletes:
 *
 *   1. self_findings rows where status='superseded' AND
 *      ran_at < now - 24h. Their job is done — a newer row carrying
 *      the same shape replaced them. Nothing in the codebase follows
 *      `superseded_by` pointers (only Finding.supersededBy is read for
 *      the MCP/REST surface, and the chain breaks gracefully when the
 *      target is missing). 24h is well past the longest reader window:
 *      patch-author scans 7d but ignores superseded; observation
 *      snapshots use 30min; judges read the most recent 20 rows.
 *
 *   2. experiment_validations rows where status in
 *      ('completed','skipped','error') AND completed_at < cutoff. These
 *      are scheduling rows whose live signal already landed in
 *      self_findings (category='validation'). 'pending' rows are NEVER
 *      deleted — a stuck pending row is a real bug the operator needs
 *      to see, not GC noise.
 *
 * Safety
 * ------
 *   - Kill switch: ~/.ohwow/findings-gc-disabled. When present, the
 *     probe writes a single info finding and exits without touching
 *     either table.
 *   - Helpers are fail-soft: any DB error returns a delete count of 0
 *     and logs a warning. Probe completion is never blocked.
 *   - Verdict is always 'pass'. This is informational accounting; a
 *     non-zero delete count is healthy, not a problem to escalate.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { pruneOldSuperseded } from '../findings-store.js';
import { pruneClosedValidations } from '../validation-store.js';
import { logger } from '../../lib/logger.js';

const HOUR_MS = 60 * 60 * 1000;
/**
 * 6h default. Rationale:
 *
 *   - supersedeDuplicates uses a 10-minute window. Once a row is
 *     superseded, by definition a newer row covers it within 10min;
 *     the older row carries no live signal.
 *   - patch-author's 7d lookback queries on ran_at without a status
 *     filter, but its candidates list is funneled through alreadyPatched
 *     (git log Fixes-Finding-Id) + tier-2 filter + revert log. A
 *     superseded row of the same shape is already represented by its
 *     active successor.
 *   - JUDGE_HISTORY_LIMIT=20 reads recent findings per experiment with
 *     no status filter; at 1 finding / 10s for chatty probes that's
 *     ~3 minutes of history — far short of 6h.
 *   - 6h still gives operators a comfortable window to query "what got
 *     superseded earlier this morning" via ohwow_list_findings with
 *     status='superseded'.
 *
 * Bump higher (e.g. 24h) if a probe shape ever needs a longer historical
 * trace.
 */
const DEFAULT_TTL_MS = 6 * HOUR_MS;

export const FINDINGS_GC_DISABLED_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'findings-gc-disabled',
);

export interface FindingsGcOptions {
  /** Override the per-table TTL. Defaults to 24h for both tables. */
  ttlMs?: number;
  /** Test-only override of the kill-switch path. */
  killSwitchPath?: string;
  /** Test-only clock override. */
  now?: () => number;
}

export interface FindingsGcEvidence extends Record<string, unknown> {
  affected_files: string[];
  killed: boolean;
  ttl_ms: number;
  cutoff_iso: string;
  deleted_findings: number;
  deleted_validations: number;
}

export class FindingsGcExperiment implements Experiment {
  readonly id = 'findings-gc';
  readonly name = 'Findings + validations storage reaper';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Superseded findings and closed validations older than the longest known reader window (24h is well past every observed lookback) are dead weight in storage. Hard-deleting them on a fixed cadence keeps fast-cadence probes from inflating runtime.db without touching live signal.';
  readonly cadence = { everyMs: 10 * 60 * 1000, runOnBoot: true };

  private readonly ttlMs: number;
  private readonly killSwitchPath: string;
  private readonly now: () => number;

  constructor(opts: FindingsGcOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.killSwitchPath = opts.killSwitchPath ?? FINDINGS_GC_DISABLED_PATH;
    this.now = opts.now ?? Date.now;
  }

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const cutoffIso = new Date(this.now() - this.ttlMs).toISOString();

    if (this.isKilled()) {
      const evidence: FindingsGcEvidence = {
        affected_files: [],
        killed: true,
        ttl_ms: this.ttlMs,
        cutoff_iso: cutoffIso,
        deleted_findings: 0,
        deleted_validations: 0,
      };
      return {
        subject: 'meta:findings-gc',
        summary: `kill switch present at ${this.killSwitchPath} — not pruning`,
        evidence,
      };
    }

    const deletedFindings = await pruneOldSuperseded(ctx.db, cutoffIso);
    const deletedValidations = await pruneClosedValidations(ctx.db, cutoffIso);

    if (deletedFindings + deletedValidations > 0) {
      logger.info(
        {
          deletedFindings,
          deletedValidations,
          cutoffIso,
          ttlHours: this.ttlMs / HOUR_MS,
        },
        '[findings-gc] pruned stale rows',
      );
    }

    const evidence: FindingsGcEvidence = {
      affected_files: [],
      killed: false,
      ttl_ms: this.ttlMs,
      cutoff_iso: cutoffIso,
      deleted_findings: deletedFindings,
      deleted_validations: deletedValidations,
    };
    const summary =
      deletedFindings + deletedValidations === 0
        ? `nothing to prune older than ${cutoffIso}`
        : `pruned ${deletedFindings} superseded finding(s) + ${deletedValidations} closed validation(s)`;
    return { subject: 'meta:findings-gc', summary, evidence };
  }

  judge(_result: ProbeResult, _history: Finding[]): Verdict {
    // Informational — a non-zero delete count is the happy path.
    return 'pass';
  }

  private isKilled(): boolean {
    try {
      return fs.existsSync(this.killSwitchPath);
    } catch {
      return false;
    }
  }
}
