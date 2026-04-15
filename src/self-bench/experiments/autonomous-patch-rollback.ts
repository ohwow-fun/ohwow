/**
 * AutonomousPatchRollbackExperiment — Layer 5b of the autonomous-
 * fixing safety floor.
 *
 * Reads git for autonomous patches still within their cool-off window,
 * reads self_findings for signals that those patches didn't fix the
 * problem they claimed to fix, and fires git revert + push on the ones
 * that went red. The emergency brake.
 *
 * Signal (tight by design)
 * ------------------------
 * For each in-window patch carrying Fixes-Finding-Id: <uuid>:
 *   1. Resolve the original finding → (experiment_id, subject).
 *   2. Look for any self_findings row with the SAME experiment_id and
 *      SAME subject whose ran_at > commit timestamp AND whose verdict
 *      is 'warning' or 'fail'.
 *   3. If found, the patch didn't heal the problem — schedule rollback.
 *
 * Why this shape: looser signals (any finding on the same files, any
 * workspace-wide regression) would be more permissive about firing
 * reverts. We'd rather miss a few and have a human triage than
 * auto-revert commits that were actually fine.
 *
 * Kill switch
 * -----------
 * Two layers. Our own cadence is always safe (probe is read-only).
 * The intervene() step is gated by ~/.ohwow/auto-revert-enabled via
 * revertCommit — without that file the experiment flags the
 * rollbacks in the ledger but does not actually mutate main.
 */

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
import {
  findAutonomousPatchesInWindow,
  revertCommit,
  type AutonomousPatch,
} from '../patch-rollback.js';

const MIN = 60 * 1000;

/** Cool-off window: patches older than this are out of scope. */
const COOLOFF_WINDOW_MS = 30 * MIN;

interface OriginalFindingRow {
  id: string;
  experiment_id: string;
  subject: string | null;
  ran_at: string;
  evidence: unknown;
}

interface RefireRow {
  id: string;
  verdict: string;
  ran_at: string;
  evidence: unknown;
}

interface RollbackCandidate {
  sha: string;
  findingId: string;
  originalExperimentId: string;
  subject: string | null;
  refireFindingId: string;
  refireVerdict: string;
  refireRanAt: string;
}

interface RollbackEvidence extends Record<string, unknown> {
  repo_root: string | null;
  patches_in_window: number;
  candidates: RollbackCandidate[];
  reason?: string;
}

export class AutonomousPatchRollbackExperiment implements Experiment {
  readonly id = 'autonomous-patch-rollback';
  readonly name = 'Autonomous patch cool-off watcher';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'An autonomous patch that does not fix its justifying finding should be ' +
    'auto-reverted inside the cool-off window. Reading Fixes-Finding-Id trailers ' +
    'against post-commit findings on the same experiment_id and subject lets the ' +
    'runtime heal itself from its own bad commits before a human has to.';
  readonly cadence = { everyMs: 5 * MIN, runOnBoot: false };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    if (!repoRoot) {
      const evidence: RollbackEvidence = {
        repo_root: null,
        patches_in_window: 0,
        candidates: [],
        reason: 'no_repo_root',
      };
      return {
        subject: 'meta:autonomous-patch-rollback',
        summary: 'repo root not configured — skipping rollback watcher',
        evidence,
      };
    }

    const patches = findAutonomousPatchesInWindow(repoRoot, COOLOFF_WINDOW_MS);
    const candidates: RollbackCandidate[] = [];
    for (const patch of patches) {
      const candidate = await this.evaluate(ctx, patch);
      if (candidate) candidates.push(candidate);
    }

    const evidence: RollbackEvidence = {
      repo_root: repoRoot,
      patches_in_window: patches.length,
      candidates,
    };
    const summary =
      candidates.length === 0
        ? `${patches.length} autonomous patch(es) in cool-off, 0 rollback candidates`
        : `${candidates.length} rollback candidate(s): ${candidates.map((c) => c.sha.slice(0, 8)).join(', ')}`;
    return { subject: 'meta:autonomous-patch-rollback', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as RollbackEvidence;
    if (ev.reason === 'no_repo_root') return 'pass';
    if (ev.candidates.length === 0) return 'pass';
    return 'fail';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    _ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict !== 'fail') return null;
    const ev = result.evidence as RollbackEvidence;
    if (!ev.repo_root || ev.candidates.length === 0) return null;

    const reverted: Array<{ sha: string; revertSha?: string; reason?: string; ok: boolean }> = [];
    for (const c of ev.candidates) {
      const reason =
        `finding ${c.originalExperimentId} re-fired verdict=${c.refireVerdict} at ${c.refireRanAt} after patch; patch did not heal`;
      const r = revertCommit(ev.repo_root, c.sha, reason);
      reverted.push({
        sha: c.sha,
        revertSha: r.revertSha,
        reason: r.reason,
        ok: r.ok,
      });
    }
    const okCount = reverted.filter((r) => r.ok).length;
    return {
      description:
        okCount === reverted.length
          ? `reverted ${okCount} autonomous patch(es) inside cool-off`
          : `attempted ${reverted.length} revert(s); ${okCount} succeeded`,
      details: { reverted },
    };
  }

  private async evaluate(
    ctx: ExperimentContext,
    patch: AutonomousPatch,
  ): Promise<RollbackCandidate | null> {
    const original = await this.fetchOriginal(ctx, patch.findingId);
    if (!original) return null;
    const originalLiterals = extractViolationLiterals(original.evidence);
    const refire = await this.fetchRefire(
      ctx,
      original.experiment_id,
      original.subject,
      patch.ts,
      patch.files,
      originalLiterals,
    );
    if (!refire) return null;
    return {
      sha: patch.sha,
      findingId: patch.findingId,
      originalExperimentId: original.experiment_id,
      subject: original.subject,
      refireFindingId: refire.id,
      refireVerdict: refire.verdict,
      refireRanAt: refire.ran_at,
    };
  }

  private async fetchOriginal(
    ctx: ExperimentContext,
    findingId: string,
  ): Promise<OriginalFindingRow | null> {
    try {
      const query = ctx.db
        .from<OriginalFindingRow>('self_findings')
        .select('id, experiment_id, subject, ran_at, evidence')
        .eq('id', findingId)
        .limit(1);
      const { data } = await query;
      const rows = (data ?? []) as OriginalFindingRow[];
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private async fetchRefire(
    ctx: ExperimentContext,
    experimentId: string,
    subject: string | null,
    afterTs: string,
    patchFiles: readonly string[],
    originalLiterals: readonly string[],
  ): Promise<RefireRow | null> {
    try {
      let builder = ctx.db
        .from<RefireRow>('self_findings')
        .select('id, verdict, ran_at, evidence')
        .eq('experiment_id', experimentId)
        .gt('ran_at', afterTs);
      if (subject !== null) {
        builder = builder.eq('subject', subject);
      }
      const { data } = await builder.limit(50);
      const rows = (data ?? []) as RefireRow[];
      // Three-level "did this patch heal" gate, most specific first:
      //
      //  1. Literal-level: if the ORIGINAL finding listed specific
      //     violation literals (source-copy-lint / dashboard-copy
      //     both do), we only consider the patch "not healed" if
      //     at least one of THOSE literals is still in the refire's
      //     violation list. A new violation on the same page about
      //     unrelated copy is NOT the same problem coming back —
      //     it's a different problem the patch never addressed.
      //
      //  2. File-level: if we don't have literal evidence, fall
      //     back to affected_files intersection. Used by
      //     experiments that populate affected_files but not
      //     violations (e.g. smoke tests).
      //
      //  3. Experiment-level: if the refire has no affected_files
      //     at all, behave like the pre-f7f7c0d gate and revert
      //     on any same-experiment-same-subject warning. Preserves
      //     the safety net for legacy experiments.
      const originalSet = new Set(originalLiterals);
      const patchedSet = new Set(normalizeFiles(patchFiles));
      for (const r of rows) {
        if (r.verdict !== 'warning' && r.verdict !== 'fail') continue;
        const refireLiterals = extractViolationLiterals(r.evidence);
        if (originalSet.size > 0 && refireLiterals.length > 0) {
          // Strict literal-level check. Only fire if at least one
          // of the patch's justifying literals is still present.
          if (refireLiterals.some((l) => originalSet.has(l))) return r;
          continue;
        }
        const affected = extractAffectedFilesFromEvidence(r.evidence);
        if (affected.length === 0) return r;
        const overlap = affected.some((f) => patchedSet.has(f));
        if (overlap) return r;
      }
      return null;
    } catch {
      return null;
    }
  }
}

function normalizeFiles(files: readonly string[]): string[] {
  return files.map((f) => f.replace(/\\/g, '/'));
}

/**
 * Pull violation literals out of evidence.violations[]. Checks both
 * `literal` and `match` fields. Returns strings ≥3 chars so a bare
 * em-dash like "—" can't match "different em-dash on another page"
 * as the same-literal-coming-back — it has to be a longer phrase
 * that uniquely identifies the specific copy we patched.
 */
function extractViolationLiterals(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== 'object') return [];
  const arr = (evidence as Record<string, unknown>).violations;
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue;
    const lit = (v as Record<string, unknown>).literal;
    const match = (v as Record<string, unknown>).match;
    if (typeof lit === 'string' && lit.length >= 3) out.push(lit);
    else if (typeof match === 'string' && match.length >= 3) out.push(match);
  }
  return out;
}

function extractAffectedFilesFromEvidence(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== 'object') return [];
  const raw = (evidence as Record<string, unknown>).affected_files;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map((p) => p.replace(/\\/g, '/'));
}
