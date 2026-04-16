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

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Default findings TTL: 6h. Rationale:
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
 *     no status filter. At 10s/finding for chatty probes that's ~3min;
 *     at 5min cadence for slow probes that's ~100min. 6h covers both.
 *   - 24h aggregators (intervention-audit, burn-rate, daily-surprise-
 *     digest) still get a 6h slice of superseded data. Tighter would
 *     undercut their denominators.
 *
 * Bump higher (e.g. 24h) if a probe shape ever needs a longer historical
 * trace; lower if disk pressure forces aggressive cleanup.
 */
const DEFAULT_FINDINGS_TTL_MS = 6 * HOUR_MS;

/**
 * Default validations TTL: 30 min. Rationale:
 *
 *   - A closed validation row (completed | skipped | error) is pure
 *     scheduling metadata. The live signal — outcome, baseline, error
 *     details — already landed in self_findings as a row with
 *     category='validation'. Nothing in the codebase reads
 *     experiment_validations after a row closes except the
 *     intervention_finding_id link for debugging.
 *   - Pending validations are NEVER deleted regardless of age, so a
 *     stuck pending row stays visible to the operator.
 *   - 30min gives operator a window to debug "what just validated and
 *     how" before the row gets reaped. Past that, the finding row in
 *     self_findings is the canonical record.
 */
const DEFAULT_VALIDATIONS_TTL_MS = 30 * MINUTE_MS;

export const FINDINGS_GC_DISABLED_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'findings-gc-disabled',
);

export interface FindingsGcOptions {
  /**
   * Findings TTL override. Defaults to 6h.
   *
   * Tuned conservatively because self_findings is read by both fast
   * judges (3min of history) and slow daily aggregators (24h windows).
   * 6h covers most readers without breaking the daily ones.
   */
  findingsTtlMs?: number;
  /**
   * Validations TTL override. Defaults to 30min.
   *
   * Aggressive because closed validation rows are scheduling metadata
   * — the live signal already lives in self_findings.
   */
  validationsTtlMs?: number;
  /**
   * Convenience: set both TTLs to the same value. Equivalent to passing
   * findingsTtlMs and validationsTtlMs to the same number. Wins over
   * the per-table overrides if all three are set (last-wins is the
   * tests' usual ergonomic choice).
   */
  ttlMs?: number;
  /** Test-only override of the kill-switch path. */
  killSwitchPath?: string;
  /** Test-only clock override. */
  now?: () => number;
}

export interface FindingsGcEvidence extends Record<string, unknown> {
  affected_files: string[];
  killed: boolean;
  findings_ttl_ms: number;
  validations_ttl_ms: number;
  findings_cutoff_iso: string;
  validations_cutoff_iso: string;
  deleted_findings: number;
  deleted_validations: number;
}

export class FindingsGcExperiment implements Experiment {
  readonly id = 'findings-gc';
  readonly name = 'Findings + validations storage reaper';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Superseded findings and closed validations age out at different rates: validations are pure scheduling metadata once closed (the signal lives in self_findings), so 30min suffices; findings carry baseline data for judges and aggregators, so 6h is the conservative floor. Hard-deleting on a fixed cadence keeps fast-cadence probes from inflating runtime.db without touching live signal.';
  readonly cadence = { everyMs: 10 * 60 * 1000, runOnBoot: true };

  private readonly findingsTtlMs: number;
  private readonly validationsTtlMs: number;
  private readonly killSwitchPath: string;
  private readonly now: () => number;

  constructor(opts: FindingsGcOptions = {}) {
    this.findingsTtlMs = opts.ttlMs ?? opts.findingsTtlMs ?? DEFAULT_FINDINGS_TTL_MS;
    this.validationsTtlMs = opts.ttlMs ?? opts.validationsTtlMs ?? DEFAULT_VALIDATIONS_TTL_MS;
    this.killSwitchPath = opts.killSwitchPath ?? FINDINGS_GC_DISABLED_PATH;
    this.now = opts.now ?? Date.now;
  }

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const nowMs = this.now();
    const findingsCutoffIso = new Date(nowMs - this.findingsTtlMs).toISOString();
    const validationsCutoffIso = new Date(nowMs - this.validationsTtlMs).toISOString();

    if (this.isKilled()) {
      const evidence: FindingsGcEvidence = {
        affected_files: [],
        killed: true,
        findings_ttl_ms: this.findingsTtlMs,
        validations_ttl_ms: this.validationsTtlMs,
        findings_cutoff_iso: findingsCutoffIso,
        validations_cutoff_iso: validationsCutoffIso,
        deleted_findings: 0,
        deleted_validations: 0,
      };
      return {
        subject: 'meta:findings-gc',
        summary: `kill switch present at ${this.killSwitchPath} — not pruning`,
        evidence,
      };
    }

    const deletedFindings = await pruneOldSuperseded(ctx.db, findingsCutoffIso);
    const deletedValidations = await pruneClosedValidations(ctx.db, validationsCutoffIso);

    if (deletedFindings + deletedValidations > 0) {
      logger.info(
        {
          deletedFindings,
          deletedValidations,
          findingsCutoffIso,
          validationsCutoffIso,
          findingsTtlHours: this.findingsTtlMs / HOUR_MS,
          validationsTtlMinutes: this.validationsTtlMs / MINUTE_MS,
        },
        '[findings-gc] pruned stale rows',
      );
    }

    const evidence: FindingsGcEvidence = {
      affected_files: [],
      killed: false,
      findings_ttl_ms: this.findingsTtlMs,
      validations_ttl_ms: this.validationsTtlMs,
      findings_cutoff_iso: findingsCutoffIso,
      validations_cutoff_iso: validationsCutoffIso,
      deleted_findings: deletedFindings,
      deleted_validations: deletedValidations,
    };
    const summary =
      deletedFindings + deletedValidations === 0
        ? `nothing to prune (findings older than ${findingsCutoffIso}, validations older than ${validationsCutoffIso})`
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
