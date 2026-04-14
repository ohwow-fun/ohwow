/**
 * ExperimentAuthorExperiment — Phase 7-D.
 *
 * The terminal slice of Phase 7. The pipeline is now:
 *
 *   ExperimentProposalGenerator (7-C)
 *     → writes ExperimentBrief rows to self_findings with
 *       category='experiment_proposal'
 *         ↓
 *   ExperimentAuthorExperiment (this)
 *     → reads one unclaimed brief per run
 *     → fillExperimentTemplate (7-B) turns it into source files
 *     → safeSelfCommit (7-A) writes, runs gates, commits
 *     → marks the brief claimed so next run picks a different one
 *         ↓
 *   next daemon restart picks up the new experiment via
 *   adaptive-scheduler registration
 *
 * Every step has its own safety layer. This experiment is the
 * tip of the autonomous-codegen pipeline — it can only touch
 * things safeSelfCommit allows it to touch, which is a narrow
 * allowlist under src/self-bench/.
 *
 * Claiming briefs
 * ---------------
 * Briefs are stored as self_findings rows with evidence.claimed=false.
 * When the author picks a brief, it writes a new "claim" finding
 * with the same subject and evidence.claimed=true + claimed_by +
 * claimed_at. Future runs read the most recent row per subject
 * and skip ones that are already claimed. This is durable across
 * daemon restarts without needing a new table.
 *
 * The runner's adaptive scheduler won't re-invoke this experiment
 * more aggressively than its cadence (1 hour default), so at most
 * one commit per hour lands autonomously. Additional safety: if
 * safeSelfCommit's kill switch is closed, the author runs the
 * full pipeline but the commit step fails with
 * "self-commit disabled by default" — the brief STAYS
 * unclaimed and the next run tries again when the operator
 * finally opens the switch. Failures don't lock briefs.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import type { ExperimentBrief } from '../experiment-template.js';
import { fillExperimentTemplate, validateBrief } from '../experiment-template.js';
import { safeSelfCommit } from '../self-commit.js';
import { writeFinding, readRecentFindings } from '../findings-store.js';

/** How many proposal rows to read per run before deciding. */
const PROPOSAL_SCAN_LIMIT = 50;

interface AuthorEvidence extends Record<string, unknown> {
  scanned_proposals: number;
  unclaimed_count: number;
  selected_brief: ExperimentBrief | null;
  commit_result: {
    ok: boolean;
    reason?: string;
    commitSha?: string;
    filesWritten?: string[];
  } | null;
}

interface ProposalCandidate {
  findingId: string;
  subject: string;
  brief: ExperimentBrief;
  ranAt: string;
}

export class ExperimentAuthorExperiment implements Experiment {
  id = 'experiment-author';
  name = 'Autonomous experiment author (Phase 7-D)';
  category = 'other' as const;
  hypothesis =
    'Unclaimed experiment proposals in the ledger can be safely turned into committed code via the Phase 7-B template + Phase 7-A safe-commit pipeline, producing new experiments without human intervention.';
  // runOnBoot: true so the first tick fires immediately after the
  // daemon picks up a new build. Operators can then watch the
  // audit log + git log for the first live authoring. Subsequent
  // runs are hourly. safeSelfCommit is still gated behind the
  // kill switch file, so enabling runOnBoot doesn't change the
  // safety posture — it just makes the first live run observable
  // at restart time instead of an hour later.
  cadence = { everyMs: 60 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const proposals = await this.readUnclaimedProposals(ctx);

    if (proposals.length === 0) {
      const evidence: AuthorEvidence = {
        scanned_proposals: 0,
        unclaimed_count: 0,
        selected_brief: null,
        commit_result: null,
      };
      return {
        subject: null,
        summary: 'no unclaimed proposals to author',
        evidence,
      };
    }

    // Pick the oldest unclaimed proposal (FIFO fairness). Proposals
    // are already sorted newest-first by readRecentFindings, so
    // reverse to pick the oldest.
    const oldest = proposals[proposals.length - 1];

    const evidence: AuthorEvidence = {
      scanned_proposals: proposals.length,
      unclaimed_count: proposals.length,
      selected_brief: oldest.brief,
      commit_result: null,
    };

    return {
      subject: `proposal:${oldest.brief.slug}`,
      summary: `selected proposal ${oldest.brief.slug} for authoring`,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as AuthorEvidence;
    if (ev.unclaimed_count === 0) return 'pass';
    return 'warning'; // warning = actionable work to do
  }

  /**
   * The real work. Takes the selected brief from probe, runs the
   * template filler, calls safeSelfCommit, records both the
   * claim-marker finding and the result. Every failure path still
   * writes evidence so operators can trace what happened.
   */
  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as AuthorEvidence;
    if (!ev.selected_brief) return null;

    const brief = ev.selected_brief;

    // Belt-and-suspenders: validate the brief again before we act
    // on it. The proposal generator already validates, but a brief
    // can be sitting in the ledger for hours — if we shipped a
    // breaking change to validateBrief between generation and
    // authoring, we want to catch it here.
    const briefError = validateBrief(brief);
    if (briefError) {
      return {
        description: `refused to author invalid brief ${brief.slug}: ${briefError}`,
        details: {
          brief_slug: brief.slug,
          validation_error: briefError,
        },
      };
    }

    // Fill the template. Throws if validation fails mid-fill,
    // which we catch and record.
    let files: ReturnType<typeof fillExperimentTemplate>;
    try {
      files = fillExperimentTemplate(brief);
    } catch (err) {
      return {
        description: `fillExperimentTemplate threw for ${brief.slug}`,
        details: {
          brief_slug: brief.slug,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // The safe-commit primitive runs all the gates (typecheck,
    // vitest on the new test file, audit log, git add/commit).
    // It returns { ok, reason?, commitSha? } and never throws.
    //
    // Commit message: deliberately long + feat(self-bench): prefix
    // so the runbook bailout "commit message < 40 chars or missing
    // prefix" is structurally impossible to trip.
    //
    // extendsExperimentId is always null in Phase 7 — the pipeline
    // is new-file-only by hard constraint. whyNotEditExisting
    // documents that constraint for operator audit.
    const commitMessage = `feat(self-bench): auto-author ${brief.slug} from proposal brief`;
    const commitResult = await safeSelfCommit({
      files: [
        { path: files.sourcePath, content: files.sourceContent },
        { path: files.testPath, content: files.testContent },
      ],
      commitMessage,
      experimentId: this.id,
      extendsExperimentId: null,
      whyNotEditExisting:
        'Phase 7-A safeSelfCommit is hard-constrained to new files only via the new-file-only policy; this brief is a green-field probe with no parent experiment to extend.',
    });

    // Always mark the claim attempt, even on failure, so operators
    // can see the pipeline activity in the ledger. On success the
    // brief is claimed and won't be re-tried. On failure we leave
    // it unclaimed so the next run tries again.
    try {
      await writeFinding(ctx.db, {
        experimentId: this.id,
        category: 'experiment_proposal',
        subject: `proposal:${brief.slug}`,
        hypothesis: `Authoring outcome for proposal ${brief.slug}`,
        verdict: commitResult.ok ? 'pass' : 'warning',
        summary: commitResult.ok
          ? `authored ${brief.slug} → commit ${commitResult.commitSha?.slice(0, 8) ?? '?'}`
          : `failed to author ${brief.slug}: ${commitResult.reason}`,
        evidence: {
          is_authoring_outcome: true,
          brief,
          claimed: commitResult.ok,
          claimed_by: commitResult.ok ? this.id : null,
          claimed_at: commitResult.ok ? new Date().toISOString() : null,
          commit_sha: commitResult.commitSha ?? null,
          files_written: commitResult.filesWritten ?? null,
          commit_ok: commitResult.ok,
          commit_reason: commitResult.reason ?? null,
        },
        interventionApplied: null,
        ranAt: new Date().toISOString(),
        durationMs: 0,
      });
    } catch {
      // non-fatal; next run will pick up where we left off
    }

    return {
      description: commitResult.ok
        ? `autonomously authored ${brief.slug} → ${commitResult.commitSha?.slice(0, 8) ?? '?'}`
        : `author attempt failed for ${brief.slug}: ${commitResult.reason}`,
      details: {
        brief_slug: brief.slug,
        template: brief.template,
        commit_ok: commitResult.ok,
        commit_sha: commitResult.commitSha,
        commit_reason: commitResult.reason,
        files_written: commitResult.filesWritten,
      },
    };
  }

  /**
   * Walk the ledger for proposal rows, group by subject, keep
   * only the latest per subject. A subject is "unclaimed" when
   * its latest row has evidence.claimed === false AND there's
   * no later row with claimed === true.
   *
   * We query two experiment_ids because the generator writes the
   * original brief findings and the author writes the claim
   * markers. Both use the same proposal:<slug> subject shape so
   * a subject-keyed map collates them correctly.
   */
  private async readUnclaimedProposals(ctx: ExperimentContext): Promise<ProposalCandidate[]> {
    const authorFindings = await ctx
      .recentFindings(this.id, PROPOSAL_SCAN_LIMIT)
      .catch(() => [] as Finding[]);
    const generatorFindings = await ctx
      .recentFindings('experiment-proposal-generator', PROPOSAL_SCAN_LIMIT)
      .catch(() => [] as Finding[]);

    const allFindings = [...authorFindings, ...generatorFindings];

    // Group by subject, keep the newest row per subject.
    const latestBySubject = new Map<string, Finding>();
    for (const f of allFindings) {
      if (!f.subject || !f.subject.startsWith('proposal:')) continue;
      const existing = latestBySubject.get(f.subject);
      if (!existing || f.ranAt > existing.ranAt) {
        latestBySubject.set(f.subject, f);
      }
    }

    const candidates: ProposalCandidate[] = [];
    for (const [subject, finding] of latestBySubject.entries()) {
      const evidence = finding.evidence as {
        claimed?: boolean;
        brief?: ExperimentBrief;
        is_experiment_proposal?: boolean;
        is_authoring_outcome?: boolean;
      };

      // Already claimed? Skip.
      if (evidence.claimed === true) continue;

      // Must have an embedded brief to be actionable.
      if (!evidence.brief) continue;

      candidates.push({
        findingId: finding.id,
        subject,
        brief: evidence.brief,
        ranAt: finding.ranAt,
      });
    }

    // Newest first by default; caller inverts for FIFO fairness.
    candidates.sort((a, b) => b.ranAt.localeCompare(a.ranAt));
    return candidates;
  }
}
