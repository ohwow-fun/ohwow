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
 *   auto-registry.ts → daemon/start.ts registration
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
import fs from 'node:fs';
import path from 'node:path';
import type { ExperimentBrief, LlmAuthoredProbeParams } from '../experiment-template.js';
import { fillExperimentTemplate, validateBrief } from '../experiment-template.js';
import { safeSelfCommit, getSelfCommitStatus } from '../self-commit.js';
import { getRuntimeConfig } from '../runtime-config.js';
import { writeFinding, readRecentFindings } from '../findings-store.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import { stripCodeFences } from './patch-author.js';

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
  /** Which bucket the picked brief came from (priority / roadmap / fifo). */
  sorting_rationale?: {
    bucket: 'priority' | 'roadmap' | 'fifo';
    matched: string | null;
    priority_count: number;
    roadmap_count: number;
    fifo_count: number;
  };
}

interface ProposalCandidate {
  findingId: string;
  subject: string;
  brief: ExperimentBrief;
  ranAt: string;
}

/**
 * Strategist-driven proposal ranker. Reads two runtime_config keys:
 *
 *   strategy.priority_experiments  - string[] of slugs the strategist /
 *     operator wants authored next. Exact-match on brief.slug.
 *   strategy.roadmap_priorities    - string[] of tokens from the roadmap
 *     observer. Substring-match against brief.slug OR brief.template so
 *     a token like "x-ops" pulls both a slug and a template family.
 *
 * Buckets, in order: priority → roadmap → fifo. Within a bucket, oldest
 * wins (FIFO fairness — starvation otherwise). A missing or empty config
 * value degrades cleanly to pure FIFO, preserving the pre-ranker
 * behaviour for any workspace that hasn't wired strategy yet.
 */
function rankProposals(proposals: ProposalCandidate[]): {
  picked: ProposalCandidate;
  rationale: NonNullable<AuthorEvidence['sorting_rationale']>;
} {
  const priorityList = getRuntimeConfig<string[]>('strategy.priority_experiments', []);
  const roadmapList = getRuntimeConfig<string[]>('strategy.roadmap_priorities', []);

  const priorityBucket: ProposalCandidate[] = [];
  const roadmapBucket: ProposalCandidate[] = [];
  const fifoBucket: ProposalCandidate[] = [];

  for (const p of proposals) {
    if (Array.isArray(priorityList) && priorityList.includes(p.brief.slug)) {
      priorityBucket.push(p);
      continue;
    }
    if (Array.isArray(roadmapList) && roadmapList.some((tok) => {
      if (typeof tok !== 'string' || tok.length === 0) return false;
      return p.brief.slug.includes(tok) || p.brief.template.includes(tok);
    })) {
      roadmapBucket.push(p);
      continue;
    }
    fifoBucket.push(p);
  }

  const oldestFirst = (arr: ProposalCandidate[]): ProposalCandidate[] =>
    [...arr].sort((a, b) => a.ranAt.localeCompare(b.ranAt));

  const priority = oldestFirst(priorityBucket);
  const roadmap = oldestFirst(roadmapBucket);
  const fifo = oldestFirst(fifoBucket);

  if (priority.length > 0) {
    return {
      picked: priority[0],
      rationale: {
        bucket: 'priority',
        matched: priority[0].brief.slug,
        priority_count: priority.length,
        roadmap_count: roadmap.length,
        fifo_count: fifo.length,
      },
    };
  }
  if (roadmap.length > 0) {
    const matched = Array.isArray(roadmapList)
      ? roadmapList.find((tok) =>
          roadmap[0].brief.slug.includes(tok) || roadmap[0].brief.template.includes(tok),
        ) ?? null
      : null;
    return {
      picked: roadmap[0],
      rationale: {
        bucket: 'roadmap',
        matched,
        priority_count: priority.length,
        roadmap_count: roadmap.length,
        fifo_count: fifo.length,
      },
    };
  }
  return {
    picked: fifo[0],
    rationale: {
      bucket: 'fifo',
      matched: null,
      priority_count: priority.length,
      roadmap_count: roadmap.length,
      fifo_count: fifo.length,
    },
  };
}

export class ExperimentAuthorExperiment implements Experiment {
  id = 'experiment-author';
  name = 'Autonomous experiment author (Phase 7-D)';
  category = 'other' as const;
  hypothesis =
    'Unclaimed experiment proposals in the ledger can be safely turned into committed code via the Phase 7-B template + Phase 7-A safe-commit pipeline, producing new experiments without human intervention.';
  // 5m cadence + runOnBoot: true during the supervised observability
  // window. Paired with the proposal generator on a 2m cadence: fresh
  // briefs sit in the ledger for at most ~5 minutes before the author
  // picks them up. The author is the expensive side of the loop
  // (typecheck + vitest + husky hooks run ~30-90s per intervene),
  // so it gets a slower cadence than the generator. The runner's
  // per-experiment inFlight guard means a slow intervene never
  // blocks the generator — the two sides stay decoupled. Revert
  // to 10m once we're bored watching. safeSelfCommit is still
  // gated behind the kill switch file, so the faster cadence
  // doesn't change the safety posture.
  cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

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

    // Rank by strategist + roadmap signals, falling back to FIFO.
    // See rankProposals() above — a workspace with no strategy wired
    // degrades cleanly to the pre-ranker FIFO behaviour.
    const { picked, rationale } = rankProposals(proposals);

    const evidence: AuthorEvidence = {
      scanned_proposals: proposals.length,
      unclaimed_count: proposals.length,
      selected_brief: picked.brief,
      commit_result: null,
      sorting_rationale: rationale,
    };

    // subject: null — we deliberately do NOT write the proposal:<slug>
    // namespace here. The author's probe-time finding would otherwise
    // collide with the generator's proposal finding under the same
    // subject, and readUnclaimedProposals's "latest-per-subject"
    // grouping would then mask the real brief with the author's
    // selected_brief shape on the very next tick. Claim markers
    // (written in intervene) still use proposal:<slug> because that's
    // how dedupe works — but probe-time state never touches that
    // namespace.
    return {
      subject: null,
      summary: `selected proposal ${picked.brief.slug} for authoring [${rationale.bucket}${rationale.matched ? `:${rationale.matched}` : ''}]`,
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

    // Layer 1 of the autonomous-fixing safety floor: route briefs
    // that target an existing parameterized probe class to a
    // registry-row append, NOT to a fresh templated TS file.
    //
    // Each round-trip through fillExperimentTemplate produced a
    // byte-identical-modulo-strings file the slop refactor (89e4516,
    // 305adab) had to collapse later. For migration_schema_probe and
    // for subprocess_health_probe whose command targets the
    // orchestrator-tool test pattern, the right mutation is "append
    // one row to the registry the parameterized class consumes."
    //
    // Routing decision lives here in the author rather than in
    // fillExperimentTemplate so the proposal generator and the brief
    // shape are unchanged — a brief is still a brief, but the author
    // chooses how to materialize it.
    const registryRoute = chooseRegistryRoute(brief);
    if (registryRoute) {
      return await this.appendToParameterizedRegistry(brief, registryRoute, ctx);
    }

    // Rule 5 path: llm_authored_probe briefs are drafted by the LLM
    // rather than slot-filled. Tier-1 new-file gates still run on the
    // result so a malformed draft fails closed without landing.
    if (brief.template === 'llm_authored_probe') {
      return await this.authorViaLlm(brief, ctx);
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

    // If the commit succeeded, append the new experiment to auto-registry.ts
    // so that daemon/start.ts picks it up on the next restart. Failure here
    // is non-fatal: the experiment file is committed and will be found on
    // a future auto-registry rebuild. Errors are swallowed and logged.
    if (commitResult.ok && commitResult.filesWritten) {
      try {
        await this.appendToAutoRegistry(brief, commitResult.filesWritten);
      } catch {
        // Non-fatal — the experiment is committed, just not yet in the registry.
      }
    }

    // Always mark the claim attempt, even on failure, so operators
    // can see the pipeline activity in the ledger. On success the
    // brief is claimed and won't be re-tried. On failure we usually
    // leave it unclaimed so the next run tries again.
    //
    // Exception: "target already exists" means a prior author (or a
    // human) already landed a file at this path. Retrying will hit
    // the same error on every cadence forever — one incident saw 17
    // retries per proposal across 10 slugs. Claim these as a terminal
    // duplicate so the brief stops being re-picked.
    const isDuplicateTarget = !commitResult.ok
      && /target already exists/i.test(commitResult.reason ?? '');
    const treatAsClaimed = commitResult.ok || isDuplicateTarget;
    const claimedBy = commitResult.ok
      ? this.id
      : isDuplicateTarget
        ? 'system:duplicate-target'
        : null;
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
          claimed: treatAsClaimed,
          claimed_by: claimedBy,
          claimed_at: treatAsClaimed ? new Date().toISOString() : null,
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
   * Rule 5 path: ask the LLM to draft both source and test files
   * for the brief, then route through safeSelfCommit's tier-1
   * new-file gates. The typecheck + vitest gates catch malformed
   * drafts — if the model returns something that doesn't compile
   * or whose test fails, the commit is refused and the brief stays
   * unclaimed for a future retry.
   */
  private async authorViaLlm(
    brief: ExperimentBrief,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied> {
    if (!ctx.engine?.modelRouter) {
      return {
        description: `cannot author ${brief.slug} — no model router on engine`,
        details: { brief_slug: brief.slug, stage: 'precheck' },
      };
    }

    // Stagnation breaker: if the last N llm-authored attempts all
    // failed at the typecheck gate, pause the template. Without this
    // the author burns model budget grinding the same error shape
    // every 5 minutes — observed in prod as 100+ consecutive
    // "Command failed: npm run typecheck" rows with no progress.
    //
    // Pause is soft: the brief stays unclaimed, the strategist sees
    // a demotion finding, and the next cycle (or a manual probe
    // revert) can retry. Threshold is tight (3) so one bad LLM day
    // doesn't gum up the whole pipeline.
    const stagnation = await this.detectAuthoringStagnation(ctx);
    if (stagnation.shouldPause) {
      return {
        description: `llm_authored template paused: ${stagnation.reason}`,
        details: {
          brief_slug: brief.slug,
          stage: 'stagnation_gate',
          template: 'llm_authored_probe',
          consecutive_failures: stagnation.consecutive,
          recent_reasons: stagnation.sampleReasons,
        },
      };
    }

    const params = brief.params as LlmAuthoredProbeParams;
    const sourcePath = `src/self-bench/experiments/${brief.slug}.ts`;
    const testPath = `src/self-bench/__tests__/${brief.slug}.test.ts`;

    const system =
      'You author one new self-bench Experiment as TypeScript. ' +
      'Return ONLY a JSON object of the shape ' +
      '{"source": "<full .ts file>", "test": "<full .test.ts file>"}. ' +
      'No markdown fences, no commentary outside the JSON. Rules:\n' +
      '  1. ESM imports must use .js extensions (e.g. ' +
      "'../experiment-types.js').\n" +
      '  2. source must `export class <PascalCaseSlug>Experiment ' +
      'implements Experiment` and set id, name, category, hypothesis, ' +
      'and cadence = { everyMs, runOnBoot: false } exactly from the brief.\n' +
      '  3. probe(ctx: ExperimentContext) must be async and return ' +
      'ProbeResult { subject, summary, evidence }. Use ctx.db for queries; ' +
      "never throw — catch and surface errors via evidence. summary MUST " +
      'be self-contained so a human or downstream LLM reading ONLY this ' +
      "row understands what happened. Use a three-line structure, newline " +
      'separated:\n' +
      "       Result: <what was measured, with the numbers — e.g. " +
      "'scanned 2000 findings, 134 matched tier-2 paths, avg drift=0.04'>\n" +
      "       Threshold: <the concrete cutoff your judge() uses — e.g. " +
      "'warn if drift > 0.1, fail if > 0.5'>\n" +
      "       Conclusion: <one sentence stating verdict vs hypothesis + " +
      "what it means for the operator — e.g. 'drift within tolerance; " +
      "hypothesis holds. No action needed.'>\n" +
      '     Evidence stays machine-readable (raw numbers, ids) for ' +
      'downstream code; summary is the narrative layer. Error paths can ' +
      "use a shorter summary (Result: <what failed>. Conclusion: probe " +
      "inconclusive, requires <what>.) but must still be narrative, not " +
      'a bare "error" string.\n' +
      '  4. judge(result, _history) returns Verdict: ' +
      "'pass' | 'warning' | 'fail'.\n" +
      '  5. No intervene method. This is observation-only.\n' +
      '  6. No console.log; no file system writes; no subprocess spawns.\n' +
      '  7. test file uses vitest (describe/it/expect) and covers at ' +
      'least one pass case and one warning-or-fail case. Mock ctx.db ' +
      'with a chainable object.\n' +
      '  8. Keep each file under 200 lines.\n' +
      // Strict-mode guardrails — these four errors dominate the typecheck
      // gate failures in the live ledger; spell them out explicitly so
      // the model stops tripping them.
      '  9. Strict TS: annotate every callback parameter. ' +
      "`(a, b) => a + b` fails; write `(a: number, b: number) => a + b`. " +
      'Applies to .reduce, .map, .filter, .sort, .forEach, .find.\n' +
      ' 10. Catch clauses: `catch (err)` makes `err` of type `unknown`. ' +
      'Narrow before using: `err instanceof Error ? err.message : String(err)`. ' +
      "Don't access `.message` or `.stack` without the narrow.\n" +
      ' 11. DatabaseAdapter method is `.from(table)`, NOT `.table(...)`. ' +
      'The chain is `ctx.db.from<Row>(\'table_name\').select(\'col1,col2\')' +
      ".eq('col', value).limit(N)` — returns `{ data, error }`.\n" +
      " 12. `category` MUST be one of the ExperimentCategory literal types " +
      "('model_health' | 'tool_reliability' | 'data_freshness' | 'other' | " +
      "'prompt_calibration' | 'canary' | 'handler_audit' | 'trigger_stability' | " +
      "'validation' | 'experiment_proposal' | 'business_outcome' | 'dm_intel'). " +
      "Declare as `readonly category: ExperimentCategory = 'other'` — the " +
      'type annotation is mandatory so a string literal doesn\'t widen.\n' +
      ' 13. Minimal skeleton (copy the shape, fill in slug/name/hypothesis):\n' +
      '```ts\n' +
      "import type { Experiment, ExperimentCategory, ExperimentContext, Finding, ProbeResult, Verdict } from '../experiment-types.js';\n" +
      'export class ExampleExperiment implements Experiment {\n' +
      "  readonly id = 'example';\n" +
      "  readonly name = 'Example';\n" +
      "  readonly category: ExperimentCategory = 'other';\n" +
      "  readonly hypothesis = 'stated hypothesis';\n" +
      '  readonly cadence = { everyMs: 600000, runOnBoot: false };\n' +
      '  async probe(ctx: ExperimentContext): Promise<ProbeResult> {\n' +
      '    try {\n' +
      "      const { data } = await ctx.db.from<{ id: string }>('some_table').select('id').limit(10);\n" +
      '      const count = (data ?? []).length;\n' +
      '      const summary = [\n' +
      '        `Result: scanned some_table, found ${count} row(s).`,\n' +
      "        'Threshold: warn if count < 1 (empty table signals missing ingestion).',\n" +
      "        count < 1 ? 'Conclusion: empty table — ingestion pipeline may be stalled, check ingest probe.' : `Conclusion: table populated (${count} rows); baseline healthy.`,\n" +
      "      ].join('\\n');\n" +
      '      return { subject: null, summary, evidence: { count } };\n' +
      '    } catch (err) {\n' +
      '      const msg = err instanceof Error ? err.message : String(err);\n' +
      "      const summary = `Result: probe threw (${msg}).\\nThreshold: any exception = fail.\\nConclusion: probe inconclusive; requires operator to check table/schema.`;\n" +
      '      return { subject: null, summary, evidence: { error: msg } };\n' +
      '    }\n' +
      '  }\n' +
      '  judge(r: ProbeResult, _h: Finding[]): Verdict {\n' +
      "    const ev = r.evidence as { count?: number; error?: string };\n" +
      "    if (ev.error) return 'fail';\n" +
      "    return (ev.count ?? 0) < 1 ? 'warning' : 'pass';\n" +
      '  }\n' +
      '}\n' +
      '```\n' +
      ' 14. Test imports the source via ' +
      "`import { <ClassName>Experiment } from '../experiments/<slug>.js'` — " +
      'tests live in src/self-bench/__tests__/, sources in ' +
      'src/self-bench/experiments/, so the relative path MUST cross into ' +
      "`../experiments/`. Never write `'../<slug>.js'` (sibling-path guess) " +
      '— the typecheck gate will reject it with TS2307.'

    const prompt = [
      `<brief>`,
      `  slug: ${brief.slug}`,
      `  name: ${brief.name}`,
      `  hypothesis: ${brief.hypothesis}`,
      `  category: ${params.category}`,
      `  everyMs: ${brief.everyMs}`,
      `  source_path: ${sourcePath}`,
      `  test_path: ${testPath}`,
      `</brief>`,
      ``,
      `<probe_description>`,
      params.probe_description,
      `</probe_description>`,
    ].join('\n');

    const llm = await runLlmCall(
      {
        modelRouter: ctx.engine.modelRouter!,
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        experimentId: this.id,
      },
      {
        purpose: 'reasoning',
        system,
        prompt,
        max_tokens: 4096,
        temperature: 0,
      },
    );
    if (!llm.ok) {
      return {
        description: `model call failed for ${brief.slug}: ${llm.error}`,
        details: { brief_slug: brief.slug, stage: 'model', error: llm.error },
      };
    }

    const parsed = parseAuthoredFiles(llm.data.text);
    if (!parsed.ok) {
      return {
        description: `could not parse model output for ${brief.slug}: ${parsed.error}`,
        details: {
          brief_slug: brief.slug,
          stage: 'parse',
          raw: llm.data.text.slice(0, 500),
        },
      };
    }

    const commitMessage = `feat(self-bench): auto-author ${brief.slug} via LLM from proposal brief`;
    // Tier-3 wiring: if the proposal generator's LLM flagged papers
    // that influenced this brief, pass them through to the commit so
    // each one lands as a Cites-Research-Paper trailer. Downstream
    // observation-probe already parses that trailer into the
    // RESEARCH_CITED_IN_COMMIT anomaly + the future ledger resolver.
    const commitResult = await safeSelfCommit({
      files: [
        { path: sourcePath, content: parsed.source },
        { path: testPath, content: parsed.test },
      ],
      commitMessage,
      experimentId: this.id,
      extendsExperimentId: null,
      whyNotEditExisting:
        'Phase 7-C Rule 5 llm_authored_probe: new-file-only probe drafted by LLM; tier-1 gates validate safety.',
      citesResearchPapers: params.cites_papers,
    });

    if (commitResult.ok && commitResult.filesWritten) {
      try {
        await this.appendToAutoRegistry(brief, commitResult.filesWritten);
      } catch {
        // non-fatal
      }
    }

    const isDuplicateTarget = !commitResult.ok
      && /target already exists/i.test(commitResult.reason ?? '');
    const treatAsClaimed = commitResult.ok || isDuplicateTarget;
    const claimedBy = commitResult.ok
      ? this.id
      : isDuplicateTarget
        ? 'system:duplicate-target'
        : null;
    try {
      await writeFinding(ctx.db, {
        experimentId: this.id,
        category: 'experiment_proposal',
        subject: `proposal:${brief.slug}`,
        hypothesis: `LLM-authored outcome for proposal ${brief.slug}`,
        verdict: commitResult.ok ? 'pass' : 'warning',
        summary: commitResult.ok
          ? `llm-authored ${brief.slug} → commit ${commitResult.commitSha?.slice(0, 8) ?? '?'}`
          : `failed to llm-author ${brief.slug}: ${commitResult.reason}`,
        evidence: {
          is_authoring_outcome: true,
          materialization: 'llm_authored',
          brief,
          claimed: treatAsClaimed,
          claimed_by: claimedBy,
          claimed_at: treatAsClaimed ? new Date().toISOString() : null,
          commit_sha: commitResult.commitSha ?? null,
          files_written: commitResult.filesWritten ?? null,
          commit_ok: commitResult.ok,
          commit_reason: commitResult.reason ?? null,
          model: llm.data.model_used,
        },
        interventionApplied: null,
        ranAt: new Date().toISOString(),
        durationMs: 0,
      });
    } catch {
      // non-fatal
    }

    return {
      description: commitResult.ok
        ? `llm-authored ${brief.slug} → ${commitResult.commitSha?.slice(0, 8) ?? '?'}`
        : `llm-author failed for ${brief.slug}: ${commitResult.reason}`,
      details: {
        brief_slug: brief.slug,
        template: brief.template,
        materialization: 'llm_authored',
        commit_ok: commitResult.ok,
        commit_sha: commitResult.commitSha,
        commit_reason: commitResult.reason,
        files_written: commitResult.filesWritten,
        model: llm.data.model_used,
      },
    };
  }

  /**
   * Append a new factory entry to src/self-bench/auto-registry.ts so
   * the daemon picks up the newly committed experiment on next restart.
   *
   * Reads the current registry file, derives the class name from the
   * source file path, inserts an import + factory line, and commits
   * the updated registry via safeSelfCommit. safeSelfCommit's
   * MODIFY_ALLOWED_EXACT_PATHS exemption means this is the one file
   * the author is allowed to update in-place.
   *
   * Non-fatal: if anything fails here the experiment is already
   * committed — it just won't be auto-registered until a human
   * or a future run repairs the registry.
   */
  private async appendToAutoRegistry(
    brief: ExperimentBrief,
    filesWritten: string[],
  ): Promise<void> {
    const status = getSelfCommitStatus();
    if (!status.repoRoot) return;

    // Find the source file path (not the test file)
    const sourcePath = filesWritten.find(
      (f) => !f.includes('__tests__'),
    );
    if (!sourcePath) return;

    const registryRelPath = 'src/self-bench/auto-registry.ts';
    const registryAbsPath = path.join(status.repoRoot, registryRelPath);

    let current: string;
    try {
      current = fs.readFileSync(registryAbsPath, 'utf-8');
    } catch {
      return; // registry doesn't exist yet — skip
    }

    // Derive the class name from the source path basename.
    // sourcePath example: 'src/self-bench/experiments/migration-schema-010-local-crm.ts'
    // → className: 'MigrationSchema010LocalCrmExperiment'
    const basename = path.basename(sourcePath, '.ts'); // 'migration-schema-010-local-crm'
    const className = basename
      .split('-')
      .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
      .join('') + 'Experiment';

    // Import path relative to auto-registry.ts
    const importPath = `./experiments/${basename}.js`;

    // Check if already present (idempotent)
    if (current.includes(className)) return;

    // Build the new lines to append
    const importLine = `import { ${className} } from '${importPath}';`;
    const factoryLine = `  () => new ${className}(),`;

    // Insert the import before the export statement
    const exportMarker = '\nexport const autoRegisteredExperiments';
    if (!current.includes(exportMarker)) return; // unexpected shape

    const withImport = current.replace(
      exportMarker,
      `\n${importLine}${exportMarker}`,
    );

    // Insert the factory before the closing '];'
    const closeMarker = '\n];';
    if (!withImport.includes(closeMarker)) return; // unexpected shape

    const updated = withImport.replace(
      closeMarker,
      `\n${factoryLine}${closeMarker}`,
    );

    // Commit via safeSelfCommit so it goes through the same gates
    await safeSelfCommit({
      files: [{ path: registryRelPath, content: updated }],
      commitMessage: `feat(self-bench): register ${brief.slug} in auto-registry`,
      experimentId: this.id,
      extendsExperimentId: null,
      whyNotEditExisting:
        'auto-registry.ts is the designated append-only manifest for autonomously authored experiments; updating it after each commit is its only purpose.',
      // Skip gates for the registry update: typecheck already ran for
      // the main experiment commit above. Running it again would add
      // 30s with no new information.
      skipGates: true,
    });
  }

  /**
   * Materialize a brief by appending one row to the parameterized
   * probe class's registry (instead of generating a fresh templated
   * TS file). Reads the registry, dedupes against the existing rows,
   * inserts a new row before the closing `];`, and commits the
   * single-file change via safeSelfCommit.
   *
   * Always writes a finding (claim outcome) to keep the proposal
   * generator's dedupe set populated, same shape as the TS-file
   * authoring path. Returns an InterventionApplied for the runner
   * to record on the author's own ledger row.
   */
  private async appendToParameterizedRegistry(
    brief: ExperimentBrief,
    route: RegistryRoute,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied> {
    const status = getSelfCommitStatus();
    if (!status.repoRoot) {
      return {
        description: `cannot append to ${route.registryPath} — repo root not configured`,
        details: { brief_slug: brief.slug, registry_path: route.registryPath },
      };
    }

    const absRegistryPath = path.join(status.repoRoot, route.registryPath);
    let current: string;
    try {
      current = fs.readFileSync(absRegistryPath, 'utf-8');
    } catch (err) {
      return {
        description: `failed to read registry ${route.registryPath} for ${brief.slug}`,
        details: {
          brief_slug: brief.slug,
          registry_path: route.registryPath,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // Dedupe: if the row's primary-key string already appears in the
    // file, the registry already covers this brief. Idempotent no-op.
    if (current.includes(route.dedupeNeedle)) {
      // Still write the claim finding so the proposal generator's
      // dedupe set advances and we don't re-author the same brief
      // forever.
      await writeAuthorClaim(ctx, this.id, brief, {
        ok: true,
        commitSha: null,
        reason: 'already_in_registry',
        registryPath: route.registryPath,
      });
      return {
        description: `${brief.slug} already present in ${route.registryPath} — no-op`,
        details: {
          brief_slug: brief.slug,
          registry_path: route.registryPath,
          dedupe_needle: route.dedupeNeedle,
          appended: false,
        },
      };
    }

    // Insert the new row before the LAST occurrence of `\n];`. Last
    // (not first) so a future hand-edit that adds a comment with
    // `];` somewhere above the array doesn't break the splice.
    const closeMarker = '\n];';
    const closeIdx = current.lastIndexOf(closeMarker);
    if (closeIdx < 0) {
      return {
        description: `registry ${route.registryPath} has unexpected shape — no '\\n];' close marker`,
        details: { brief_slug: brief.slug, registry_path: route.registryPath },
      };
    }
    const updated =
      current.slice(0, closeIdx) +
      `\n  ${route.rowSource},` +
      current.slice(closeIdx);

    const commitMessage = `feat(self-bench): append ${brief.slug} to ${path.basename(route.registryPath)}`;
    const commitResult = await safeSelfCommit({
      files: [{ path: route.registryPath, content: updated }],
      commitMessage,
      experimentId: this.id,
      extendsExperimentId: null,
      whyNotEditExisting:
        'Layer 1 of the autonomous-fixing safety floor: this registry is the designated append-only home for the parameterized probe class — appending here is structurally safer than emitting a fresh templated TS file per row.',
      // Skip gates for a single-row append: validateBrief already ran,
      // typecheck on this addition would add 30s for no new signal.
      skipGates: true,
    });

    await writeAuthorClaim(ctx, this.id, brief, {
      ok: commitResult.ok,
      commitSha: commitResult.commitSha ?? null,
      reason: commitResult.reason ?? null,
      registryPath: route.registryPath,
    });

    return {
      description: commitResult.ok
        ? `appended ${brief.slug} to ${route.registryPath} → commit ${commitResult.commitSha?.slice(0, 8) ?? '?'}`
        : `failed to append ${brief.slug} to ${route.registryPath}: ${commitResult.reason}`,
      details: {
        brief_slug: brief.slug,
        registry_path: route.registryPath,
        commit_ok: commitResult.ok,
        commit_sha: commitResult.commitSha,
        commit_reason: commitResult.reason,
        appended: commitResult.ok,
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
  /**
   * Count consecutive llm-authored failures in the recent window.
   * Returns `shouldPause=true` when the last N authoring outcomes
   * all came back with commit_ok=false — the signal that the
   * LLM→typecheck pipeline is stuck in a rut. Keeps reading past
   * non-authoring rows (stagnation-gate demotions, registry appends)
   * so a short burst of those doesn't reset the counter.
   */
  private async detectAuthoringStagnation(
    ctx: ExperimentContext,
  ): Promise<{
    shouldPause: boolean;
    consecutive: number;
    reason: string;
    sampleReasons: string[];
  }> {
    const THRESHOLD = 3;
    /**
     * Time-based auto-release: if the most recent llm_authored failure
     * is older than this, reset the counter. Without this the gate is
     * a trap — it only clears on a successful commit, but it doesn't
     * let the author *attempt* a commit while gated, so no success can
     * ever happen. The pause becomes permanent until operator action.
     * 30 minutes lets a short failure burst pause the loop, but a
     * longer-term pause auto-resumes to give the next proposal cohort
     * a shot. If the re-attempt also fails 3× consecutively, the gate
     * re-engages naturally.
     */
    const STALE_FAILURE_MS = 30 * 60 * 1000;
    const findings = await ctx
      .recentFindings(this.id, 30)
      .catch(() => [] as Finding[]);
    let consecutive = 0;
    const sampleReasons: string[] = [];
    let mostRecentFailureAt: number | null = null;
    for (const f of findings) {
      const ev = f.evidence as {
        is_authoring_outcome?: boolean;
        materialization?: string;
        commit_ok?: boolean;
        commit_reason?: string | null;
      };
      if (!ev.is_authoring_outcome) continue;
      if (ev.materialization !== 'llm_authored') break;
      if (ev.commit_ok === true) break;
      if (mostRecentFailureAt === null) mostRecentFailureAt = Date.parse(f.ranAt);
      consecutive += 1;
      if (ev.commit_reason && sampleReasons.length < 3) {
        sampleReasons.push(ev.commit_reason.slice(0, 120));
      }
      if (consecutive >= THRESHOLD) break;
    }
    const stale =
      mostRecentFailureAt !== null &&
      Date.now() - mostRecentFailureAt >= STALE_FAILURE_MS;
    if (consecutive >= THRESHOLD && !stale) {
      return {
        shouldPause: true,
        consecutive,
        reason: `${consecutive} consecutive llm_authored failures`,
        sampleReasons,
      };
    }
    return { shouldPause: false, consecutive, reason: '', sampleReasons };
  }

  private async readUnclaimedProposals(ctx: ExperimentContext): Promise<ProposalCandidate[]> {
    const authorFindings = await ctx
      .recentFindings(this.id, PROPOSAL_SCAN_LIMIT)
      .catch(() => [] as Finding[]);
    const generatorFindings = await ctx
      .recentFindings('experiment-proposal-generator', PROPOSAL_SCAN_LIMIT)
      .catch(() => [] as Finding[]);

    const allFindings = [...authorFindings, ...generatorFindings];

    // Group by subject, keep the newest row per subject. Only
    // consider findings that are actually proposal-shaped — either
    // original briefs from the generator (is_experiment_proposal) or
    // claim-marker outcomes from this experiment (is_authoring_outcome).
    // Stray probe-time findings from older author versions that wrote
    // into the proposal:<slug> namespace are filtered out here so
    // they can't mask a real brief.
    const latestBySubject = new Map<string, Finding>();
    for (const f of allFindings) {
      if (!f.subject || !f.subject.startsWith('proposal:')) continue;
      const ev = f.evidence as {
        is_experiment_proposal?: boolean;
        is_authoring_outcome?: boolean;
      };
      if (!ev.is_experiment_proposal && !ev.is_authoring_outcome) continue;
      const existing = latestBySubject.get(f.subject);
      if (!existing || f.ranAt > existing.ranAt) {
        latestBySubject.set(f.subject, f);
      }
    }

    // Per-slug auto-demotion. Build a failure counter per proposal
    // slug so a brief that has repeatedly failed to author falls out
    // of the unclaimed pool even if it's technically still unclaimed.
    // Two failures is enough — templates fail the same way each time,
    // so the third retry is near-guaranteed wasted model budget.
    const PER_SLUG_FAILURE_THRESHOLD = 2;
    const failuresBySlug = new Map<string, number>();
    for (const f of authorFindings) {
      const ev = f.evidence as {
        is_authoring_outcome?: boolean;
        commit_ok?: boolean;
        brief?: { slug?: string };
      };
      if (!ev.is_authoring_outcome) continue;
      if (ev.commit_ok !== false) continue;
      const slug = ev.brief?.slug;
      if (!slug) continue;
      failuresBySlug.set(slug, (failuresBySlug.get(slug) ?? 0) + 1);
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

      // Per-slug demotion: if this brief has already failed to author
      // N times, skip it. The brief stays in the ledger (operators can
      // unstick manually by opening the strategist) but doesn't burn
      // more budget in the authoring loop.
      const failures = failuresBySlug.get(evidence.brief.slug) ?? 0;
      if (failures >= PER_SLUG_FAILURE_THRESHOLD) continue;

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

// ---------------------------------------------------------------------------
// Layer 1 helpers — registry routing for parameterized probe classes.
// ---------------------------------------------------------------------------

interface RegistryRoute {
  /** Path relative to repo root, e.g. 'src/self-bench/registries/migration-schema-registry.ts'. */
  registryPath: string;
  /** Source for the new row, e.g. `{ migrationFile: '008-plans.sql', expectedTables: ['x'] }`. */
  rowSource: string;
  /**
   * String to grep for in the existing registry to dedupe. Pick a primary-
   * key-shaped substring like `'008-plans.sql'` or `'agents'`. Must be
   * unique enough that finding it in the file means "this row is already
   * registered."
   */
  dedupeNeedle: string;
}

/** Match the toolchain-tool-test command shape Rule 4 of the proposal generator emits. */
const TOOLCHAIN_TOOL_TEST_COMMAND_RE =
  /^npx vitest run src\/orchestrator\/tools\/__tests__\/([a-z][a-z0-9-]*)\.test\.ts$/;

/**
 * Decide whether this brief should land as a registry-row append
 * (Layer 1 path) or fall through to the templated TS file generation
 * (legacy path). Returns null when the legacy path is right.
 *
 * Routing rules:
 *   - migration_schema_probe → migration-schema registry, always.
 *   - subprocess_health_probe whose command matches the orchestrator-
 *     tool test pattern → toolchain-test registry. Singletons (Rule 3
 *     typecheck/lint/tests) and any future subprocess shapes still
 *     get the templated TS file path.
 *   - any other template → null (legacy TS file path).
 */
export function chooseRegistryRoute(brief: ExperimentBrief): RegistryRoute | null {
  if (brief.template === 'migration_schema_probe') {
    const params = brief.params as { migration_file: string; expected_tables: string[] };
    const tablesLiteral = params.expected_tables
      .map((t) => `'${escapeSingleQuoted(t)}'`)
      .join(', ');
    return {
      registryPath: 'src/self-bench/registries/migration-schema-registry.ts',
      rowSource: `{ migrationFile: '${escapeSingleQuoted(params.migration_file)}', expectedTables: [${tablesLiteral}] }`,
      dedupeNeedle: `'${escapeSingleQuoted(params.migration_file)}'`,
    };
  }

  if (brief.template === 'subprocess_health_probe') {
    const params = brief.params as { command: string };
    const match = TOOLCHAIN_TOOL_TEST_COMMAND_RE.exec(params.command);
    if (!match) return null; // singleton or other subprocess shape — TS file path
    const slug = match[1];
    return {
      registryPath: 'src/self-bench/registries/toolchain-test-registry.ts',
      rowSource: `{ slug: '${escapeSingleQuoted(slug)}' }`,
      // Single-quoted slug occurrence is unique enough — the registry's
      // only string literals are slugs, so collisions are impossible.
      dedupeNeedle: `'${escapeSingleQuoted(slug)}'`,
    };
  }

  return null;
}

/**
 * Escape a string for use inside single-quoted JavaScript literals.
 * Defensive — validateBrief restricts allowed characters in the params
 * fields the routing reads, but the registries are committed source
 * files so we never want to inject a stray apostrophe.
 */
function escapeSingleQuoted(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Write the same proposal-claim finding shape both authoring paths
 * (TS file and registry append) need. Keeps the proposal generator's
 * dedupe set in sync regardless of which path materialized the brief.
 * Errors are swallowed — the autonomous loop must not fall over on
 * a transient ledger write failure.
 */
/**
 * Parse the LLM's {"source": "...", "test": "..."} response for
 * llm_authored_probe authoring. Tolerates a wrapping code fence
 * (via stripCodeFences) and verifies both fields are non-trivial
 * TypeScript. Length floor mirrors patch-author's whole-file guard.
 */
function parseAuthoredFiles(
  raw: string,
): { ok: true; source: string; test: string } | { ok: false; error: string } {
  const unfenced = stripCodeFences(raw);
  let obj: unknown;
  try {
    obj = JSON.parse(unfenced);
  } catch (err) {
    return {
      ok: false,
      error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'not an object' };
  const rec = obj as Record<string, unknown>;
  if (typeof rec.source !== 'string' || typeof rec.test !== 'string') {
    return { ok: false, error: 'missing string source/test fields' };
  }
  if (rec.source.length < 100) return { ok: false, error: 'source too short' };
  if (rec.test.length < 100) return { ok: false, error: 'test too short' };
  return { ok: true, source: rec.source, test: rec.test };
}

async function writeAuthorClaim(
  ctx: ExperimentContext,
  experimentId: string,
  brief: ExperimentBrief,
  outcome: { ok: boolean; commitSha: string | null; reason: string | null; registryPath: string },
): Promise<void> {
  try {
    await writeFinding(ctx.db, {
      experimentId,
      category: 'experiment_proposal',
      subject: `proposal:${brief.slug}`,
      hypothesis: `Registry-append outcome for proposal ${brief.slug}`,
      verdict: outcome.ok ? 'pass' : 'warning',
      summary: outcome.ok
        ? `appended ${brief.slug} to ${outcome.registryPath} → commit ${outcome.commitSha?.slice(0, 8) ?? 'noop'}`
        : `failed to append ${brief.slug} to ${outcome.registryPath}: ${outcome.reason}`,
      evidence: {
        is_authoring_outcome: true,
        materialization: 'registry_append',
        brief,
        registry_path: outcome.registryPath,
        claimed: outcome.ok,
        claimed_by: outcome.ok ? experimentId : null,
        claimed_at: outcome.ok ? new Date().toISOString() : null,
        commit_sha: outcome.commitSha,
        commit_ok: outcome.ok,
        commit_reason: outcome.reason,
      },
      interventionApplied: null,
      ranAt: new Date().toISOString(),
      durationMs: 0,
    });
  } catch {
    // non-fatal
  }
}
