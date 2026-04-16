/**
 * PatchAuthorExperiment — capstone application of Layers 1-9.
 *
 * Reads self_findings for warning|fail rows whose evidence.affected_files
 * intersect a tier-2 path, filters out findings already addressed by an
 * existing autonomous patch (commits carrying Fixes-Finding-Id: <id>),
 * surfaces the remaining set as patch candidates, and (when the
 * patch-author kill switch is open) drafts and commits one patch per
 * tick via the full Layer 1-9 pipeline.
 *
 * Two-switch model
 * ----------------
 * ~/.ohwow/self-commit-enabled — gate on safeSelfCommit (Layer 1+).
 * ~/.ohwow/patch-author-enabled — gate on this experiment's intervene
 * step. Both must be present for an autonomous patch to land. Either
 * being closed leaves the experiment in observe-only mode (records
 * candidates in the ledger, doesn't draft a patch).
 *
 * Per-tick budget
 * ---------------
 * One patch per tick by design. Tighter than safeSelfCommit's daily
 * budget (24/day). Keeps each tick's blast radius to a single file
 * change so a runaway model output can't fan out into a sweep.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import {
  getSelfCommitStatus,
  safeSelfCommit,
  type FindingLookup,
} from '../self-commit.js';
import { buildContextPack } from '../context-pack.js';
import { workspaceLayoutFor } from '../../config.js';
import {
  recordProposedPatch,
  hasRecentlyRevertedPatch,
} from '../../lib/patches-attempted-log.js';
import { rankCandidates, type EvidencePointer } from '../value-ranker.js';
import {
  readActivePriorities,
  matchActivePriorities,
  appendWorkLogEntry,
  type PriorityDoc,
} from '../../lib/priorities.js';
import { getAllowedPrefixes, resolvePathTier, resolvePatchMode } from '../path-trust-tiers.js';
import {
  parseStringLiteralEditsResponse,
  applyStringLiteralEdits,
  type StringLiteralEdit,
} from './string-literal-patch.js';
import {
  buildProvenancePrompt,
  validateProvenanceInputs,
  type ProvenanceInput,
} from '../patch-prompt-provenance.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import { writeFinding } from '../findings-store.js';
import { logger } from '../../lib/logger.js';
import { redactForPrompt } from '../../lib/prompt-redact.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Findings older than this are stale per safeSelfCommit's 7d window. */
const FINDING_LOOKBACK_MS = 7 * DAY;

interface FindingRow {
  id: string;
  experiment_id: string;
  subject: string | null;
  verdict: string;
  ran_at: string;
  evidence: unknown;
}

export interface PatchCandidate {
  findingId: string;
  experimentId: string;
  subject: string | null;
  verdict: string;
  ranAt: string;
  /** Subset of affected_files that resolve to tier-2 paths. */
  tier2Files: string[];
}

interface CandidatesEvidence extends Record<string, unknown> {
  repo_root: string | null;
  tier2_prefixes: string[];
  findings_scanned: number;
  candidates: PatchCandidate[];
  /**
   * Rank breakdown for the top-scored candidate. Carries the score, per-
   * component breakdown, and human-readable rationale so operators can
   * see WHY the loop picked this patch over others — and flag a bad
   * weighting before it ships N patches in the wrong direction.
   */
  top_pick?: {
    findingId: string;
    score: number;
    breakdown: {
      revenue_proximity: number;
      evidence_strength: number;
      blast_radius: number;
      recency: number;
    };
    rationale: string[];
  } | null;
  reason?: string;
}

export class PatchAuthorExperiment implements Experiment {
  readonly id = 'patch-author';
  readonly name = 'Autonomous patch author (observe-only)';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Recent warning|fail findings whose affected_files intersect a tier-2 ' +
    'path describe a real, currently-broken contract that the autonomous ' +
    'loop could fix. Surfacing them as patch candidates lets the operator ' +
    'audit the judgment before model-driven authoring is enabled.';
  readonly cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    const tier2Prefixes = listTier2Prefixes();
    if (tier2Prefixes.length === 0) {
      const evidence: CandidatesEvidence = {
        repo_root: repoRoot,
        tier2_prefixes: [],
        findings_scanned: 0,
        candidates: [],
        reason: 'no_tier2_paths',
      };
      return {
        subject: 'meta:patch-author',
        summary: 'no tier-2 paths registered — nothing to author against',
        evidence,
      };
    }

    const findings = await this.fetchRecentFindings(ctx);
    const alreadyPatched = repoRoot
      ? collectFindingIdsAlreadyPatched(repoRoot, FINDING_LOOKBACK_MS)
      : new Set<string>();

    const candidates: PatchCandidate[] = [];
    for (const row of findings) {
      if (row.verdict !== 'warning' && row.verdict !== 'fail') continue;
      if (alreadyPatched.has(row.id)) continue;
      const affected = extractAffectedFiles(row.evidence);
      const tier2Files = affected.filter((f) => resolvePathTier(f).tier === 'tier-2');
      if (tier2Files.length === 0) continue;
      // Cheap extra filter: if the finding's evidence lists specific
      // violation literals, require at least one of them to appear
      // verbatim in one of the tier-2 source files. DOM-scraped
      // findings often attribute runtime data (e.g. a person's role)
      // to a page path; that data isn't in source, so a patch-author
      // LLM call would waste a token budget refusing at the applier.
      //
      // For string-literal-mode targets we go further: the model can
      // ONLY emit copy-level edits, so a finding with no usable
      // literal evidence (e.g. dashboard-smoke fires on a runtime
      // failure that has no text to rewrite) will produce an empty
      // edits array. Reject those at probe time instead of burning
      // an LLM call. Whole-file-mode targets keep the permissive
      // fallback so pure-util fuzzers keep working.
      if (repoRoot) {
        const anyStringLiteral = tier2Files.some(
          (f) => resolvePatchMode(f) === 'string-literal',
        );
        if (!evidenceLiteralsAppearInSource(repoRoot, tier2Files, row.evidence, anyStringLiteral)) {
          continue;
        }
      }
      // Phase 3 — don't re-propose a (finding, file-shape) the author
      // already tried and Layer 5 reverted inside the lookback window.
      // Pure-query filter: no LLM, no git work. Fail-soft: the helper
      // returns alreadyReverted=false on any DB hiccup, so a transient
      // read problem degrades to permissive (author still tries) rather
      // than freezing the loop.
      try {
        const revertCheck = await hasRecentlyRevertedPatch(
          ctx.db,
          ctx.workspaceId,
          row.id,
          tier2Files,
        );
        if (revertCheck.alreadyReverted) {
          logger.debug(
            {
              findingId: row.id,
              files: tier2Files,
              commitSha: revertCheck.commitSha,
              revertedAt: revertCheck.lastAttemptAt,
            },
            '[patch-author] skipping candidate; same shape was reverted recently',
          );
          continue;
        }
      } catch {
        // Treat as permissive — same fail-soft policy the helper uses.
      }
      candidates.push({
        findingId: row.id,
        experimentId: row.experiment_id,
        subject: row.subject,
        verdict: row.verdict,
        ranAt: row.ran_at,
        tier2Files,
      });
    }

    // Phase 3 — rank candidates highest-value-first so the
    // one-per-tick intervene budget goes to the most revenue-proximal
    // well-evidenced candidate rather than whatever happened to sort
    // first. `otherFindings` is the whole recent-findings set so the
    // ranker can measure evidence strength (how many other rows
    // point at the same subject/files).
    // Phase 6 — flatten active-priority tags into the ranker input so
    // a candidate whose signals intersect an operator-declared
    // priority tag gets a direct score bump.
    const otherFindings: EvidencePointer[] = findings.map((r) => ({
      subject: r.subject,
      affectedFiles: extractAffectedFiles(r.evidence),
    }));
    const priorityTags = collectActivePriorityTags(ctx.workspaceSlug ?? null);
    const ranked = rankCandidates({
      candidates,
      otherFindings,
      priorityTags,
    });
    const rankedOrdered: PatchCandidate[] = ranked.map((r) => r.candidate);
    const topBreakdown = ranked[0]
      ? {
          findingId: ranked[0].candidate.findingId,
          score: ranked[0].score,
          breakdown: ranked[0].breakdown,
          rationale: ranked[0].rationale,
        }
      : null;

    const evidence: CandidatesEvidence = {
      repo_root: repoRoot,
      tier2_prefixes: tier2Prefixes,
      findings_scanned: findings.length,
      candidates: rankedOrdered,
      top_pick: topBreakdown,
    };
    const summary =
      rankedOrdered.length === 0
        ? `${findings.length} finding(s) scanned, 0 tier-2 patch candidates`
        : `${rankedOrdered.length} tier-2 candidate(s); top=${ranked[0].candidate.experimentId}/${ranked[0].candidate.findingId.slice(0, 8)} score=${ranked[0].score.toFixed(2)}`;
    return { subject: 'meta:patch-author', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as CandidatesEvidence;
    if (ev.reason === 'no_tier2_paths') return 'pass';
    if (ev.candidates.length === 0) return 'pass';
    return 'warning';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict !== 'warning') return null;
    const ev = result.evidence as CandidatesEvidence;
    if (ev.candidates.length === 0) return null;

    // Observe-only path: log the candidates; do not draft a patch.
    if (!isPatchAuthorEnabled()) {
      for (const c of ev.candidates) {
        logger.info(
          {
            findingId: c.findingId,
            experimentId: c.experimentId,
            tier2Files: c.tier2Files,
          },
          '[patch-author] candidate observed (kill switch closed — no patch)',
        );
      }
      return {
        description: `observe-only: surfaced ${ev.candidates.length} tier-2 candidate(s); disabled (create ${PATCH_AUTHOR_DISABLED_PATH} to keep off)`,
        details: { mode: 'observe-only', candidates: ev.candidates },
      };
    }

    // Authoring path: pick one candidate per tick.
    const candidate = ev.candidates[0];
    const repoRoot = ev.repo_root;
    if (!repoRoot) {
      return {
        description: 'no repo root configured — cannot author a patch',
        details: { mode: 'error', candidate },
      };
    }
    if (!ctx.engine?.modelRouter) {
      return {
        description: 'no model router on engine — cannot author a patch',
        details: { mode: 'error', candidate },
      };
    }

    const outcome = await this.draftAndCommit(candidate, repoRoot, ctx, ev.top_pick ?? null);
    return {
      description: outcome.description,
      details: { mode: 'authoring', candidate, ...outcome.details },
    };
  }

  private async draftAndCommit(
    candidate: PatchCandidate,
    repoRoot: string,
    ctx: ExperimentContext,
    topPick: NonNullable<CandidatesEvidence['top_pick']> | null,
  ): Promise<{ description: string; details: Record<string, unknown> }> {
    const targetPath = candidate.tier2Files[0];
    const sourceContent = readRepoFile(repoRoot, targetPath);
    if (sourceContent === null) {
      return {
        description: `could not read source file ${targetPath}`,
        details: { stage: 'read-source', target: targetPath },
      };
    }

    const findingRow = await fetchFindingRow(ctx, candidate.findingId);
    if (!findingRow) {
      return {
        description: `finding ${candidate.findingId} not found in db`,
        details: { stage: 'read-finding' },
      };
    }
    const findingBlob = JSON.stringify(
      {
        id: findingRow.id,
        experiment_id: findingRow.experiment_id,
        verdict: findingRow.verdict,
        summary: findingRow.summary ?? '',
        hypothesis: findingRow.hypothesis ?? '',
        evidence: findingRow.evidence,
      },
      null,
      2,
    );

    const patchMode = resolvePatchMode(targetPath);
    const violationsForFile =
      patchMode === 'string-literal'
        ? extractViolationsForFile(findingRow.evidence, targetPath)
        : [];

    const provenanceInputs: ProvenanceInput[] = [
      { source: 'finding', ref: candidate.findingId, content: findingBlob },
      { source: 'source-file', ref: targetPath, content: sourceContent },
    ];
    const validation = validateProvenanceInputs(provenanceInputs, repoRoot);
    if (!validation.ok) {
      return {
        description: `provenance validation failed: ${validation.reason}`,
        details: { stage: 'provenance' },
      };
    }
    let promptBody = buildProvenancePrompt(provenanceInputs);
    if (violationsForFile.length > 0) {
      // Enumerate each violation so the model returns ONE edit per
      // rule hit in a single JSON array. Without this the model
      // tends to emit a single-line edit per commit even when the
      // finding reports 4+ violations in the same file — the "keep
      // changes minimal" nudge in the system prompt pushes toward
      // conservatism unless the task is spelled out.
      promptBody += `\n\n<violations ref="${targetPath}" count="${violationsForFile.length}">\n${renderViolationList(violationsForFile)}\n</violations>`;
    }

    // Inject roadmap context so the model understands the loop's goal,
    // the auto-revert mechanism, and the current convergence state.
    // Read-only — the model must not modify the roadmap, only use it
    // for context when authoring the patch. Pass it through the
    // deterministic redactor first: roadmap prose may quote findings
    // that carry real emails/handles/URLs from the running system, and
    // the model could echo any such identifier into its patch output.
    // Redaction is stable (same input → same placeholder) so it doesn't
    // degrade the LLM's ability to reason about distinct entities.
    const rawRoadmapCtx = loadRoadmapContext(repoRoot);
    if (rawRoadmapCtx) {
      const { redacted, replacements } = redactForPrompt(rawRoadmapCtx);
      if (replacements.length > 0) {
        logger.debug(
          { count: replacements.length, kinds: [...new Set(replacements.map((r) => r.kind))] },
          '[patch-author] redacted identifiers from roadmap prompt context',
        );
      }
      promptBody += `\n\n<context name="autonomy-goal">\n${redacted}\n</context>`;
    }

    // Inject recent "what failed" observations from the hippocampus
    // consolidator. These are the patterns the reflection pass flagged
    // over the last 24h — seeding the LLM with them nudges it toward
    // fixes that address repeated failures, not just this one finding.
    // Run through the same prompt redactor so no real identifier leaks.
    const rawReflectionCtx = await loadReflectionContext(ctx.db, ctx.workspaceId);
    if (rawReflectionCtx) {
      const { redacted } = redactForPrompt(rawReflectionCtx);
      promptBody += `\n\n<context name="recent-reflections">\n${redacted}\n</context>`;
    }

    // Phase 2: cross-domain context pack. Widens the author's view
    // beyond "here's the file and the finding" to include sales-side
    // state the operator keeps track of: attribution rollup, active
    // goals, recent rejection reasons, roadmap gaps, operator-authored
    // priorities (Phase 6). The pack is fail-soft — a missing source
    // degrades to no section, never blocks the author.
    try {
      const layout = ctx.workspaceSlug ? workspaceLayoutFor(ctx.workspaceSlug) : null;
      const approvalsPath = layout ? path.join(layout.dataDir, 'x-approvals.jsonl') : null;
      const pack = await buildContextPack({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        repoRoot,
        approvalsJsonlPath: approvalsPath,
        workspaceDataDir: layout?.dataDir ?? null,
      });
      const packBody = pack.toPromptString();
      if (packBody.length > 0) {
        promptBody += `\n\n${packBody}`;
        logger.debug(
          { sections: pack.summary(), target: targetPath },
          '[patch-author] appended cross-domain context pack',
        );
      }
    } catch (err) {
      logger.warn({ err }, '[patch-author] context-pack build failed; proceeding without');
    }

    const sys =
      patchMode === 'string-literal'
        ? buildStringLiteralSystemPrompt(targetPath, violationsForFile.length)
        : buildWholeFileSystemPrompt(targetPath);

    const llm = await runLlmCall(
      {
        modelRouter: ctx.engine.modelRouter!,
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        experimentId: this.id,
      },
      {
        purpose: 'reasoning',
        system: sys,
        prompt: promptBody,
        max_tokens: 4096,
        temperature: 0,
      },
    );
    if (!llm.ok) {
      return {
        description: `model call failed: ${llm.error}`,
        details: { stage: 'model' },
      };
    }

    let newContent: string;
    let editsApplied: StringLiteralEdit[] | null = null;
    if (patchMode === 'string-literal') {
      const parsed = parseStringLiteralEditsResponse(llm.data.text);
      if (!Array.isArray(parsed)) {
        return {
          description: `string-literal edits parse failed: ${parsed.error}`,
          details: { stage: 'parse', raw: llm.data.text.slice(0, 500) },
        };
      }
      const applied = applyStringLiteralEdits(sourceContent, parsed);
      if (!applied.ok || !applied.content) {
        return {
          description: `string-literal edits could not be applied: ${applied.reason}`,
          details: { stage: 'apply', edits: parsed, raw: llm.data.text.slice(0, 500) },
        };
      }
      newContent = applied.content;
      editsApplied = parsed;
    } else {
      newContent = stripCodeFences(llm.data.text);
      if (!newContent || newContent.length < 20) {
        return {
          description: 'model returned empty or implausibly short patch',
          details: { stage: 'parse', length: newContent.length },
        };
      }
    }

    const findingResolver = (id: string): Promise<FindingLookup | null> =>
      resolveFindingForCommit(ctx, id);

    // Phase 4 — cross-domain pollination. When the ranker picked this
    // candidate because of a revenue-proximal signal (sales experiment,
    // goal/attribution subject, or funnel path), record it as a
    // Cites-Sales-Signal trailer so operators can grep for patches
    // whose selection was steered by sales state. Advisory — absent
    // when the pick scored zero on revenue_proximity.
    const citesSalesSignal = topPick && topPick.breakdown.revenue_proximity > 0
      ? buildSalesSignalTrailer(candidate, topPick)
      : undefined;
    const hypothesisBlock = citesSalesSignal
      ? `\nHypothesis: ${buildCrossDomainHypothesis(candidate, findingRow.hypothesis ?? null, findingRow.summary ?? null)}\n`
      : `\nHypothesis: ${findingRow.hypothesis ?? '(none)'}\n`;

    const commitMessage =
      `feat(self-bench): patch ${path.basename(targetPath)} for finding ${candidate.findingId.slice(0, 8)}\n\n` +
      `Autonomous tier-2 patch in response to finding ${candidate.findingId} ` +
      `(experiment=${candidate.experimentId}, verdict=${candidate.verdict}).\n` +
      hypothesisBlock +
      `Summary: ${findingRow.summary ?? '(none)'}\n`;

    const commit = await safeSelfCommit({
      files: [{ path: targetPath, content: newContent }],
      commitMessage,
      experimentId: this.id,
      extendsExperimentId: null,
      whyNotEditExisting:
        `Tier-2 patch path: this commit MODIFIES ${targetPath} in response to finding ${candidate.findingId}; the patch is the intervention.`,
      fixesFindingId: candidate.findingId,
      citesSalesSignal,
      findingResolver,
    });
    let loggedPriorities: PriorityDoc[] = [];
    if (commit.ok) {
      // Phase 3 — record the attempt so the auto-revert path can flip
      // its outcome and the next probe tick can skip (finding, file-
      // shape) shapes that recently reverted. Pure DB write; never
      // blocks the commit-already-landed result.
      try {
        await recordProposedPatch({
          db: ctx.db,
          workspaceId: ctx.workspaceId,
          findingId: candidate.findingId,
          filePaths: [targetPath],
          commitSha: commit.commitSha ?? null,
          patchMode: patchMode,
          tier: 'tier-2',
        });
      } catch (err) {
        logger.warn({ err, commitSha: commit.commitSha }, '[patch-author] patches-attempted-log record failed');
      }
      // Phase 6 — append a work-log entry to any active priority whose
      // tags match this candidate's signals. Operator sees the patch
      // land in the priority file without checking git. Fail-soft —
      // a write error just means no work-log entry; commit already
      // succeeded.
      try {
        loggedPriorities = logCommitToMatchingPriorities(
          ctx.workspaceSlug ?? null,
          candidate,
          commit.commitSha ?? null,
          citesSalesSignal,
        );
      } catch (err) {
        logger.warn({ err, commitSha: commit.commitSha }, '[patch-author] priorities work-log append failed');
      }
    }
    if (!commit.ok) {
      return {
        description: `safeSelfCommit refused: ${commit.reason}`,
        details: { stage: 'commit', reason: commit.reason, model: llm.data.model_used },
      };
    }

    // P1 post-patch verification gate. Re-read the patched file
    // synchronously and flag any original violation literal that
    // survived the patch. Non-blocking: the commit already landed,
    // we just surface a warning finding so Layer 5 can revert sooner
    // than the next scheduled probe (kills the 10min lag).
    let postPatchRemaining: string[] = [];
    if (patchMode === 'string-literal' && violationsForFile.length > 0) {
      postPatchRemaining = remainingPostPatchLiterals(
        repoRoot,
        targetPath,
        violationsForFile,
      );
      if (postPatchRemaining.length > 0) {
        try {
          await writeFinding(ctx.db, {
            experimentId: this.id,
            category: 'other',
            subject: `post_patch_verification_failed:${targetPath}`,
            hypothesis:
              'Autonomous patch should remove every violation literal named in the originating finding.',
            verdict: 'warning',
            summary:
              `${postPatchRemaining.length}/${violationsForFile.length} original violation literal(s) still present in ${targetPath} after commit ${commit.commitSha?.slice(0, 12)}`,
            evidence: {
              post_patch_verification_failed: true,
              commit_sha: commit.commitSha ?? null,
              target_path: targetPath,
              origin_finding_id: candidate.findingId,
              remaining_literals: postPatchRemaining,
              original_violation_count: violationsForFile.length,
              affected_files: [targetPath],
            },
            interventionApplied: null,
            ranAt: new Date().toISOString(),
            durationMs: 0,
          });
          logger.warn(
            {
              commitSha: commit.commitSha,
              targetPath,
              remaining: postPatchRemaining.length,
              total: violationsForFile.length,
              originFindingId: candidate.findingId,
            },
            '[patch-author] post-patch verification failed — literals still present',
          );
        } catch (err) {
          logger.warn(
            { err, commitSha: commit.commitSha, targetPath },
            '[patch-author] post-patch verification finding write failed',
          );
        }
      }
    }

    return {
      description: `landed autonomous patch ${commit.commitSha?.slice(0, 12)} on ${targetPath}`,
      details: {
        stage: 'committed',
        commitSha: commit.commitSha,
        patchMode,
        edits: editsApplied,
        post_patch_remaining: postPatchRemaining,
        priorities_logged: loggedPriorities.map((p) => ({ slug: p.slug, title: p.title })),
        model: llm.data.model_used,
        provider: llm.data.provider,
        cost_cents: llm.data.cost_cents,
      },
    };
  }

  private async fetchRecentFindings(
    ctx: ExperimentContext,
  ): Promise<FindingRow[]> {
    const since = new Date(Date.now() - FINDING_LOOKBACK_MS).toISOString();
    try {
      // Order newest-first so the 2000-row limit keeps the most actionable
      // recent findings rather than the oldest ones. Without this, once the
      // table exceeds 2000 rows in the 7-day window (which happens quickly at
      // 5-min probe cadences), the query returns stale findings from 7 days
      // ago and the patch-author sees "0 candidates" even when live violations
      // exist.
      const { data } = await ctx.db
        .from<FindingRow>('self_findings')
        .select('id, experiment_id, subject, verdict, ran_at, evidence')
        .gte('ran_at', since)
        .order('ran_at', { ascending: false })
        .limit(2000);
      return (data ?? []) as FindingRow[];
    } catch {
      return [];
    }
  }
}

/**
 * Flatten the active priorities' tags for this workspace into a
 * unique, lowercased list. Empty array when the workspace slug is
 * unknown or the priorities dir is missing. Fail-soft — never throws.
 */
export function collectActivePriorityTags(workspaceSlug: string | null): string[] {
  if (!workspaceSlug) return [];
  try {
    const dataDir = workspaceLayoutFor(workspaceSlug).dataDir;
    const active = readActivePriorities(dataDir);
    const tags = new Set<string>();
    for (const p of active) {
      for (const t of p.tags) {
        const clean = t.trim().toLowerCase();
        if (clean.length > 0) tags.add(clean);
      }
    }
    return [...tags];
  } catch {
    return [];
  }
}

/**
 * After a successful autonomous commit, append a work-log entry to
 * every active priority whose tags match the candidate's signals.
 * Operator opens the priority file and sees the ohwow entry land in
 * real-time. Never throws — a permission error on the priorities dir
 * just degrades to no work-log entry.
 */
export function logCommitToMatchingPriorities(
  workspaceSlug: string | null,
  candidate: PatchCandidate,
  commitSha: string | null,
  citesSalesSignal: string | undefined,
): PriorityDoc[] {
  if (!workspaceSlug) return [];
  let active: PriorityDoc[];
  try {
    active = readActivePriorities(workspaceLayoutFor(workspaceSlug).dataDir);
  } catch {
    return [];
  }
  if (active.length === 0) return [];
  const matches = matchActivePriorities(active, {
    experimentId: candidate.experimentId,
    subject: candidate.subject,
    paths: candidate.tier2Files,
  });
  for (const p of matches) {
    const sha = commitSha ? commitSha.slice(0, 12) : '?';
    const citesBlock = citesSalesSignal ? `\nCites-Sales-Signal: ${citesSalesSignal}` : '';
    const message =
      `Landed autonomous patch ${sha} in response to ${candidate.experimentId} finding ${candidate.findingId.slice(0, 8)}. ` +
      `Files: ${candidate.tier2Files.join(', ')}.${citesBlock}`;
    appendWorkLogEntry({
      priority: p,
      actor: 'ohwow/patch-author',
      message,
    });
  }
  return matches;
}

/**
 * Build the Cites-Sales-Signal trailer body. Names the revenue-
 * proximal signal(s) that pushed this candidate to the top of the
 * value ranker. Format: semicolon-separated key=value pairs, short
 * enough to live inline in a commit trailer (<240 chars total).
 */
export function buildSalesSignalTrailer(
  candidate: PatchCandidate,
  topPick: NonNullable<CandidatesEvidence['top_pick']>,
): string {
  const parts: string[] = [];
  parts.push(`experiment=${candidate.experimentId}`);
  if (candidate.subject) parts.push(`subject=${candidate.subject}`);
  parts.push(`score=${topPick.score.toFixed(2)}`);
  parts.push(`revenue_proximity=${topPick.breakdown.revenue_proximity.toFixed(2)}`);
  if (topPick.breakdown.evidence_strength > 0) {
    parts.push(`evidence_strength=${topPick.breakdown.evidence_strength.toFixed(2)}`);
  }
  return parts.join('; ');
}

/**
 * Build a "When I change X, metric Y should move because Z" hypothesis
 * string the commit message carries when the patch was selected for
 * its revenue-proximity. Keeps the pattern consistent so operators
 * can scan for "When I change..." in cross-domain commits and audit
 * whether the claimed hypothesis actually played out in the
 * attribution rollup N ticks later.
 */
export function buildCrossDomainHypothesis(
  candidate: PatchCandidate,
  findingHypothesis: string | null,
  findingSummary: string | null,
): string {
  const metric = guessRevenueMetric(candidate);
  const change = candidate.tier2Files[0] ?? 'this file';
  const becauseFragment = findingHypothesis ?? findingSummary ?? 'the finding describes the broken contract';
  return `When I change ${change}, ${metric} should move because ${becauseFragment.slice(0, 200)}`;
}

function guessRevenueMetric(candidate: PatchCandidate): string {
  if (candidate.experimentId === 'attribution-observer') return 'overall_conversion_rate';
  if (candidate.experimentId === 'outreach-thermostat') return 'proposal rejection rate';
  if (candidate.experimentId === 'revenue-pipeline-observer') return 'goal pacing';
  if (candidate.subject && candidate.subject.startsWith('goal:')) return `goal ${candidate.subject.slice(5)}`;
  if (candidate.subject && candidate.subject.startsWith('attribution:')) return 'overall_conversion_rate';
  if (candidate.experimentId === 'x-engagement-observer') return 'engagement depth';
  return 'a revenue metric';
}

function buildWholeFileSystemPrompt(targetPath: string): string {
  return (
    'You patch one TypeScript file in response to one self-bench finding. ' +
    'Output ONLY the full new contents of the source file shown in the ' +
    '<source name="source-file"> block. No markdown fences, no commentary, ' +
    'no diff. The output must be valid TypeScript that preserves the file\'s ' +
    "public API and only changes what the finding describes. Keep changes " +
    'minimal — one top-level symbol modified at most. The file you are ' +
    `editing is referenced by ref="${targetPath}".`
  );
}

function buildStringLiteralSystemPrompt(
  targetPath: string,
  violationCount: number,
): string {
  const multi = violationCount > 1;
  const batchRule = multi
    ? `  5. The <violations> block lists ALL ${violationCount} rule hits in this file. Return ONE edit per listed violation in the SAME JSON array. Do not emit separate patches for separate violations — fix every listed violation in this single response.\n`
    : '  5. Fix what the finding describes. Do not touch unrelated strings.\n';
  return (
    'You patch one TypeScript/TSX file by emitting a JSON array of ' +
    'string-literal edits. The file is referenced by ref="' +
    targetPath +
    '" in the <source name="source-file"> block. Rules:\n' +
    '  1. Output ONLY a JSON array. No markdown fences, no commentary.\n' +
    '  2. Each element is {"find": string, "replace": string, ' +
    '"occurrence"?: number}.\n' +
    '  3. `find` must match characters that live INSIDE a string ' +
    'literal, template-literal chunk, or JSX text in the source. Do ' +
    'NOT include surrounding quotes, JSX tags, or any syntax outside ' +
    'the string.\n' +
    '  4. `find` must match the source exactly. Whitespace matters. ' +
    'If `find` could match more than once, include a 1-based ' +
    '`occurrence` to disambiguate.\n' +
    batchRule +
    '  6. No identifier renames, no logic changes, no imports.\n' +
    '  7. `replace` must differ from `find` and must obey the ' +
    'project copywriting rules the finding cites.\n' +
    'Example: [{"find":"Failed to save.","replace":"Couldn\'t save. ' +
    'Try again?"},{"find":"Please enter a name","replace":"Give it a name first"}]'
  );
}

interface ViolationSpec {
  literal: string;
  ruleId?: string;
  message?: string;
}

/**
 * Pull out every violation from evidence.violations[] that names
 * `targetPath` as its source file, keeping the literal/match text
 * plus rule metadata. Skips violations whose literal is absent from
 * the row or shorter than 3 chars (too coarse to patch reliably).
 */
export function extractViolationsForFile(
  evidence: unknown,
  targetPath: string,
): ViolationSpec[] {
  if (!evidence || typeof evidence !== 'object') return [];
  const arr = (evidence as Record<string, unknown>).violations;
  if (!Array.isArray(arr)) return [];
  const out: ViolationSpec[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue;
    const row = v as Record<string, unknown>;
    const file = typeof row.file === 'string' ? row.file : undefined;
    // If the violation tags a file, filter to ours; otherwise keep
    // it (older finding shapes don't always attribute per-row).
    if (file && file !== targetPath) continue;
    const lit = typeof row.literal === 'string' ? row.literal : undefined;
    const match = typeof row.match === 'string' ? row.match : undefined;
    const literal = (lit && lit.length >= 3) ? lit : (match && match.length >= 3 ? match : null);
    if (!literal) continue;
    // Dedupe identical literals within one finding — four violations
    // of the same literal would otherwise produce four prompt lines.
    if (seen.has(literal)) continue;
    seen.add(literal);
    out.push({
      literal,
      ruleId: typeof row.ruleId === 'string' ? row.ruleId : undefined,
      message: typeof row.message === 'string' ? row.message : undefined,
    });
  }
  return out;
}

export function renderViolationList(violations: readonly ViolationSpec[]): string {
  return violations
    .map((v, i) => {
      const head = `  ${i + 1}. [${v.ruleId ?? 'rule'}] ${JSON.stringify(v.literal)}`;
      return v.message ? `${head}\n     ${v.message}` : head;
    })
    .join('\n');
}

/** All currently-registered tier-2 prefixes (longest-prefix-match candidates). */
export function listTier2Prefixes(): string[] {
  return getAllowedPrefixes().filter(
    (prefix) => resolvePathTier(prefix).tier === 'tier-2',
  );
}

/**
 * Does at least one violation literal from `evidence.violations[]`
 * appear verbatim in any of `tier2Files`? Returns true (permissive)
 * when evidence has no violations array or no usable literal
 * strings — other finding shapes keep flowing through unchanged.
 * Short literals (<3 chars) are ignored so a stray single-character
 * match like "—" on its own can't hide a real miss.
 */
/**
 * Post-commit check: given the list of violation literals the patch
 * was supposed to remove, return the ones still present in the
 * on-disk copy of `targetPath`. Empty array = patch fully addressed
 * the cited violations. Used by the P1 verification gate to surface
 * partial-patch cases immediately instead of waiting for the next
 * scheduled lint probe (cuts ~10min lag before Layer 5 revert).
 */
export function remainingPostPatchLiterals(
  repoRoot: string,
  targetPath: string,
  violations: readonly { literal: string }[],
): string[] {
  let src: string;
  try {
    src = fs.readFileSync(path.join(repoRoot, targetPath), 'utf-8');
  } catch {
    return [];
  }
  const remaining: string[] = [];
  const seen = new Set<string>();
  for (const v of violations) {
    if (typeof v.literal !== 'string' || v.literal.length < 3) continue;
    if (seen.has(v.literal)) continue;
    seen.add(v.literal);
    if (src.includes(v.literal)) remaining.push(v.literal);
  }
  return remaining;
}

export function evidenceLiteralsAppearInSource(
  repoRoot: string,
  tier2Files: readonly string[],
  evidence: unknown,
  strict = false,
): boolean {
  if (!evidence || typeof evidence !== 'object') return !strict;
  const violations = (evidence as Record<string, unknown>).violations;
  if (!Array.isArray(violations)) return !strict;
  const literals: string[] = [];
  for (const v of violations) {
    if (!v || typeof v !== 'object') continue;
    const vv = v as Record<string, unknown>;
    const lit = vv.literal;
    const match = vv.match;
    // Violations carrying a `ruleId` come from deterministic copy-lint
    // rules (source-copy-lint, dashboard-copy). Their `literal`/`match`
    // is often a single punctuation char (—, ', ") that's still a valid
    // freshness check: "is this char still present in the source?".
    // For other evidence shapes (DOM-scraped text, heuristic matches)
    // a short substring matches too promiscuously, so require 3+.
    const hasRuleId = typeof vv.ruleId === 'string' && vv.ruleId.length > 0;
    const minLen = hasRuleId ? 1 : 3;
    if (typeof lit === 'string' && lit.length >= minLen) literals.push(lit);
    else if (typeof match === 'string' && match.length >= minLen) literals.push(match);
  }
  if (literals.length === 0) return !strict;
  for (const file of tier2Files) {
    let src: string;
    try {
      src = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
    } catch {
      continue;
    }
    for (const lit of literals) {
      if (src.includes(lit)) return true;
    }
  }
  return false;
}

/**
 * Load a compact excerpt from the roadmap suite — Known Gaps (roadmap/gaps.md)
 * and the Active Focus section of AUTONOMY_ROADMAP.md — to give the LLM context
 * about the loop's current convergence state and why patches need to hold.
 * Returns null when both files are absent so this is always a soft enhancement.
 */
function loadRoadmapContext(repoRoot: string): string | null {
  const sections: string[] = [];
  try {
    const gaps = fs.readFileSync(path.join(repoRoot, 'roadmap/gaps.md'), 'utf-8');
    const gapMatch = gaps.match(/##\s+Known Gaps[\s\S]*$/);
    if (gapMatch) sections.push(gapMatch[0].trim());
  } catch {
    // optional
  }
  try {
    const index = fs.readFileSync(path.join(repoRoot, 'AUTONOMY_ROADMAP.md'), 'utf-8');
    const focusMatch = index.match(/##\s+(?:\d+\.\s+)?Active Focus[\s\S]*?(?=\n##\s|$)/);
    if (focusMatch) sections.push(focusMatch[0].trim());
  } catch {
    // optional
  }
  if (sections.length === 0) return null;
  return sections.join('\n\n');
}

/**
 * Load up to 5 recent reflection observations (affect='failed' or
 * 'repeated') from affective_memories, formatted as a compact bullet
 * list. Returns null when the table has no reflection rows. Safe
 * against a missing table or query failure — the patch-author path
 * must keep working when the hippocampus hasn't run yet.
 */
export async function loadReflectionContext(
  db: { from: (table: string) => unknown },
  workspaceId: string,
): Promise<string | null> {
  try {
    const chain = db.from('affective_memories') as {
      select: (cols: string) => {
        eq: (col: string, val: unknown) => {
          in: (col: string, vals: unknown[]) => {
            order: (col: string, opts: { ascending: boolean }) => {
              limit: (n: number) => Promise<{ data: Array<{ affect: string; content: string }> | null }>;
            };
          };
        };
      };
    };
    const result = await chain
      .select('affect, content')
      .eq('workspace_id', workspaceId)
      .in('affect', ['failed', 'repeated'])
      .order('created_at', { ascending: false })
      .limit(5);
    const rows = result.data ?? [];
    if (rows.length === 0) return null;
    const lines = rows.map((r) => `- [${r.affect}] ${r.content}`);
    return `Recent reflections from the hippocampus consolidator (last 24h):\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}

/** Pull a string[] out of evidence.affected_files; safe against missing/bad shapes. */
export function extractAffectedFiles(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== 'object') return [];
  const raw = (evidence as Record<string, unknown>).affected_files;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map((p) => path.normalize(p).replace(/\\/g, '/'));
}

/**
 * Patch-author kill switch — now opt-OUT. Distinct from self-commit and
 * auto-revert so the operator can disable authoring without disabling reverts
 * (and vice versa). Enabled by default; create the disabled file to turn off.
 */
export const PATCH_AUTHOR_DISABLED_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'patch-author-disabled',
);

/** Test-only env var that forces patch-author DISABLED regardless of filesystem. */
const PATCH_AUTHOR_TEST_DENY_ENV = 'OHWOW_PATCH_AUTHOR_TEST_DENY';

/** Test-only override for the disabled-file path. Null = use the default. */
let patchAuthorDisabledPathOverride: string | null = null;

/**
 * Test-only override for the kill-switch disabled-file path. Pass a path to a
 * non-existent file to simulate patch-author being disabled, or null to restore.
 */
export function _setPatchAuthorKillSwitchPathForTests(p: string | null): void {
  patchAuthorDisabledPathOverride = p;
}

export function isPatchAuthorEnabled(): boolean {
  if (process.env[PATCH_AUTHOR_TEST_DENY_ENV] === '1') return false;
  const disabledPath = patchAuthorDisabledPathOverride ?? PATCH_AUTHOR_DISABLED_PATH;
  try {
    return !fs.existsSync(disabledPath);
  } catch {
    return true;
  }
}

function readRepoFile(repoRoot: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
  } catch {
    return null;
  }
}

interface FullFindingRow {
  id: string;
  experiment_id: string;
  verdict: string;
  ran_at: string;
  hypothesis: string | null;
  summary: string | null;
  evidence: unknown;
}

async function fetchFindingRow(
  ctx: ExperimentContext,
  findingId: string,
): Promise<FullFindingRow | null> {
  try {
    const { data } = await ctx.db
      .from<FullFindingRow>('self_findings')
      .select('id, experiment_id, verdict, ran_at, hypothesis, summary, evidence')
      .eq('id', findingId)
      .limit(1);
    const rows = (data ?? []) as FullFindingRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a finding into the narrow shape safeSelfCommit's Layer 2 gate
 * needs. Maps verdict (string) to the typed union and pulls
 * affected_files out of evidence.
 */
async function resolveFindingForCommit(
  ctx: ExperimentContext,
  findingId: string,
): Promise<FindingLookup | null> {
  const row = await fetchFindingRow(ctx, findingId);
  if (!row) return null;
  const verdict =
    row.verdict === 'pass' ||
    row.verdict === 'warning' ||
    row.verdict === 'fail' ||
    row.verdict === 'error'
      ? row.verdict
      : 'fail';
  return {
    id: row.id,
    verdict,
    ranAt: row.ran_at,
    affectedFiles: extractAffectedFiles(row.evidence),
  };
}

/**
 * Strip a single fenced code block if the model wrapped its answer.
 * Permissive about the fence language tag. Trims leading/trailing
 * whitespace either way.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (fence) return fence[1].trim();
  return trimmed;
}

/**
 * Scan git log for autonomous commits in the lookback window carrying a
 * Fixes-Finding-Id: <uuid> trailer. Those finding ids have already been
 * addressed and should not appear as fresh candidates. Pure read.
 */
export function collectFindingIdsAlreadyPatched(
  repoRoot: string,
  windowMs: number,
): Set<string> {
  const since = Math.ceil(windowMs / 1000);
  const out = new Set<string>();
  let log: string;
  try {
    log = execSync(
      `git log --since=${since}.seconds.ago --pretty=format:%B%x1e`,
      { cwd: repoRoot, encoding: 'utf-8', timeout: 30_000 },
    );
  } catch {
    return out;
  }
  const records = log.split('\x1e');
  for (const rec of records) {
    const m = rec.match(/^Fixes-Finding-Id:\s*([^\s]+)\s*$/m);
    if (m && m[1]) out.add(m[1]);
  }
  return out;
}
