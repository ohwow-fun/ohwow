/**
 * ExperimentProposalGenerator — Phase 7-C.
 *
 * The question-generating layer, upstream of the code writer.
 * Every run it reads the ledger + live system state and asks
 * "what's unexplained?", producing experiment briefs as findings
 * with category='experiment_proposal'. Each brief is a structured
 * JSON payload describing a new experiment's slug, template,
 * cadence, and template-specific parameters — exactly the shape
 * fillExperimentTemplate (Phase 7-B) consumes.
 *
 * The proposal generator is narrow on purpose and grows one rule
 * at a time. Today it runs four:
 *
 *   Rule 1 (model_latency_probe): traffic-driven. For each model_id
 *     in llm_calls with enough recent calls, proposes a latency probe.
 *
 *   Rule 2 (migration_schema_probe): RETIRED 2026-04-16. Migration
 *     schema probes are now maintained deterministically by
 *     scripts/regen-migration-schema-registry.mjs + a pre-commit
 *     hook. The rule stays visible in the probe evidence as a zero
 *     so operators can see it was considered and skipped, but no
 *     longer burns an autonomous-commit cycle per new migration.
 *
 *   Rule 3 (subprocess_health_probe — toolchain singletons): proposes
 *     three fixed experiments once each, then dedupe stops them
 *     forever. These model the developer workflow directly:
 *       toolchain-typecheck  — npm run typecheck (30m)
 *       toolchain-lint       — npm run lint       (1h)
 *       toolchain-tests      — npm test           (2h)
 *     Once authored, these run on cadence and write pass/fail
 *     findings for every daemon restart. A 'fail' finding is the
 *     ledger entry a future Phase 7-E can read to know "the type
 *     checker has been red since <timestamp>" without humans
 *     watching a terminal.
 *
 *   Rule 4 (subprocess_health_probe — existing tool test coverage):
 *     code-reading. Scans src/orchestrator/tools/__tests__/*.test.ts
 *     for test files that already exist and proposes a
 *     'toolchain-tool-test-<name>' probe per file. Running a real
 *     test is useful signal: the ledger knows whether those tests
 *     are passing or broken. Capped at 3/tick like Rule 2.
 *     (Previously this rule scanned for missing test files and
 *     proposed running ghost paths that always failed — fixed.)
 *
 * Future rules: per-trigger coverage, per-agent config health,
 * per-provider cost. Each is another pass through probe().
 *
 * Why this is a separate experiment from the author
 * -------------------------------------------------
 * Separation of concerns. The generator's job is to produce
 * well-structured briefs. The author's job (Phase 7-D) is to
 * turn briefs into code and commit. Keeping them apart means:
 *   - The generator can be tested without involving git at all
 *   - Operators can inspect briefs in the ledger before the
 *     author picks them up
 *   - A kill switch on 7-D (safeSelfCommit disabled) leaves 7-C
 *     still producing briefs that an operator can choose to
 *     hand-implement
 *   - Future LLM-backed generators can swap in without touching
 *     the author side
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import type {
  ExperimentBrief,
  LlmAuthoredProbeParams,
  ModelLatencyProbeParams,
  SubprocessHealthProbeParams,
} from '../experiment-template.js';
import { validateBrief } from '../experiment-template.js';
import { writeFinding } from '../findings-store.js';
import { getSelfCommitStatus } from '../self-commit.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import { stripCodeFences } from './patch-author.js';

/** How many recent llm_calls rows to inspect per model for latency stats. */
const SAMPLE_WINDOW = 200;
/**
 * Minimum calls a model needs before it's eligible for a proposal.
 * Lowered from 20 → 5 for the supervised observation loop: on the
 * current daemon's traffic shape (~5 distinct models, most with <20
 * samples in a week), a 20-sample floor starved the pipeline of
 * new proposals. 5 samples is enough to establish rough p50/p90/p99
 * for threshold derivation; if the resulting experiment produces
 * noisy findings, the adaptive scheduler will stretch its cadence.
 */
const MIN_CALLS_FOR_PROPOSAL = 5;
/** How far back to look for existing proposals to avoid duplicates. */
const DEDUPE_WINDOW_DAYS = 14;

/** Slug length ceiling (validateBrief enforces the same value). */
const SLUG_MAX_LENGTH = 50;

/**
 * Rule 3 — toolchain singleton definitions. Three fixed experiments,
 * one per developer-workflow command. Each is proposed once (dedupe
 * stops re-emission forever), then runs on the baked-in cadence.
 */
const TOOLCHAIN_EXPERIMENTS: ReadonlyArray<{
  slug: string;
  name: string;
  description: string;
  command: string;
  everyMs: number;
  timeoutMs: number;
  hypothesis: string;
}> = Object.freeze([
  {
    slug: 'toolchain-typecheck',
    name: 'TypeScript type checker health',
    description: 'TypeScript type checker (npm run typecheck)',
    command: 'npm run typecheck',
    everyMs: 30 * 60 * 1000,     // 30m — fast feedback on type regressions
    timeoutMs: 3 * 60 * 1000,    // 3 min ceiling
    hypothesis: 'npm run typecheck exits with code 0 on every run.',
  },
  {
    slug: 'toolchain-lint',
    name: 'ESLint linter health',
    description: 'ESLint linter (npm run lint)',
    command: 'npm run lint',
    everyMs: 60 * 60 * 1000,     // 1h — lint drifts slower than types
    timeoutMs: 2 * 60 * 1000,    // 2 min ceiling
    hypothesis: 'npm run lint exits with code 0 on every run.',
  },
  {
    slug: 'toolchain-tests',
    name: 'Full test suite health',
    description: 'Full test suite (npm test)',
    command: 'npm test',
    everyMs: 2 * 60 * 60 * 1000, // 2h — tests are slower to run
    timeoutMs: 5 * 60 * 1000,    // 5 min ceiling
    hypothesis: 'npm test exits with code 0 on every run.',
  },
]);

/**
 * Rule 4 throttle: never emit more than N missing-tool-test briefs
 * per tick so the author queue doesn't spike on the first run.
 */
const MAX_TOOL_TEST_PROPOSALS_PER_TICK = 3;
/** Cadence baked into each generated tool-test probe. */
const TOOL_TEST_PROBE_EVERY_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Rule 5 — LLM-creative proposals. Fires only when rules 1-4 return
 * zero new briefs. The model is asked to propose 1-3 novel experiment
 * briefs that use template='llm_authored_probe' — ExperimentAuthor
 * drafts the .ts source on the authoring side.
 */
const MAX_LLM_PROPOSALS_PER_TICK = 3;
/** Top experiments whose recent findings are surfaced to the model for context. */
const RULE5_CONTEXT_EXPERIMENTS: readonly string[] = [
  'patch-author',
  'roadmap-updater',
  'experiment-author',
  'experiment-proposal-generator',
];
/** How many recent findings to pass in per context experiment. */
const RULE5_FINDINGS_PER_EXPERIMENT = 5;
/** Default cadence for llm-authored probes (1h, mirrors migration probes). */
const LLM_AUTHORED_PROBE_EVERY_MS = 60 * 60 * 1000;
/** How many arXiv KB entries to inline into the Rule 5 prompt. */
const RULE5_ARXIV_LIMIT = 6;
/** How many recent self-observation KB entries to inline. */
const RULE5_SELF_OBS_LIMIT = 3;
/** Abstract snippet cap — keeps the prompt bounded when 6 papers all have 1KB summaries. */
const RULE5_KB_SNIPPET_CHARS = 360;
/** Top-N aggregate gap tokens inlined — one line, comma-separated. */
const RULE5_GAP_AGGREGATE_LIMIT = 10;
/** Max per-paper gap entries — bounded because a 5-paper scan can emit 20+ concepts. */
const RULE5_GAP_PAPER_LIMIT = 3;

interface LlmCallRow {
  model: string;
  latency_ms: number;
  created_at: string;
}

interface ProposalGeneratorEvidence extends Record<string, unknown> {
  inspected_models: number;
  existing_proposals: number;
  new_proposals: number;
  skipped_due_to_low_samples: number;
  migrations_scanned: number;
  migration_files_with_tables: number;
  new_migration_proposals: number;
  migration_repo_root_unavailable: boolean;
  new_toolchain_proposals: number;
  tool_handlers_scanned: number;
  tool_handlers_missing_tests: number;
  new_tool_test_proposals: number;
  rule5_fired: boolean;
  rule5_skipped_reason: string | null;
  new_llm_authored_proposals: number;
  proposals: ExperimentBrief[];
}

/**
 * Turn a model id like "qwen/qwen3.5-35b-a3b" into a slug-safe
 * fragment: "qwen-qwen3-5-35b-a3b-latency".
 */
function modelToSlug(modelId: string): string {
  const cleaned = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${cleaned}-latency`;
}

/** Percentile of a sorted ascending array. Linear interpolation, clamped. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor((p / 100) * sortedAsc.length)),
  );
  return sortedAsc[idx];
}

export class ExperimentProposalGenerator implements Experiment {
  id = 'experiment-proposal-generator';
  name = 'Experiment proposal generator (Phase 7-C)';
  category = 'other' as const;
  hypothesis =
    'Every model that appears in llm_calls with meaningful traffic should have a dedicated latency probe in the self-bench ledger. Models without one are candidates for auto-generation.';
  // 2m cadence + runOnBoot: true during the supervised observability
  // window. The generator is read-only — probe + intervene just scan
  // llm_calls and dedupe against the ledger, no git mutation, no LLM,
  // no cost — so it's safe to run frequently. Paired with the
  // experiment-author on a 5m cadence: every generator tick can
  // surface a new model, and the author picks them up within a few
  // minutes rather than hours. Revert to 10m once we're bored
  // watching the self-improvement loop live.
  cadence = { everyMs: 2 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    // 1. Pull recent llm_calls grouped by model. One broader query,
    //    bucket in memory.
    const since = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data: callsData } = await ctx.db
      .from<LlmCallRow>('llm_calls')
      .select('model, latency_ms, created_at')
      .gte('created_at', since)
      .limit(5000);

    const calls = (callsData ?? []) as LlmCallRow[];
    const byModel = new Map<string, number[]>();
    for (const call of calls) {
      if (typeof call.latency_ms !== 'number' || call.latency_ms < 0) continue;
      const bucket = byModel.get(call.model) ?? [];
      bucket.push(call.latency_ms);
      if (bucket.length <= SAMPLE_WINDOW) byModel.set(call.model, bucket);
    }

    // 2. Read prior proposals — both active ones and ones that
    //    have already been authored. Dedupe by brief.slug so we
    //    don't re-propose the same model every hour.
    const existingProposals = await this.readExistingProposalSlugs(ctx);

    const proposals: ExperimentBrief[] = [];
    let skippedLowSamples = 0;

    for (const [model, latencies] of byModel.entries()) {
      if (latencies.length < MIN_CALLS_FOR_PROPOSAL) {
        skippedLowSamples += 1;
        continue;
      }
      const slug = modelToSlug(model);
      if (existingProposals.has(slug)) continue;

      // Derive warn/fail thresholds from the observed distribution.
      const sorted = [...latencies].sort((a, b) => a - b);
      const p50 = percentile(sorted, 50);
      const p90 = percentile(sorted, 90);
      const p99 = percentile(sorted, 99);

      // Guard against degenerate p90 == p50. Give the warn threshold
      // a 20% headroom above p50 if the distribution is tight.
      const warnMs = Math.max(p90, Math.round(p50 * 1.2));
      // fail must be strictly greater than warn — clamp to at least
      // warn+500ms so a very flat distribution still gets a
      // meaningful ceiling.
      const failMs = Math.max(p99, warnMs + 500);

      // sample_size is the rolling window the generated experiment
      // will probe at runtime. min_samples is the floor below which
      // the experiment returns 'warning' instead of a verdict.
      // Clamp min_samples to sample_size so the brief is structurally
      // valid even for low-traffic models — validateBrief requires
      // min_samples <= sample_size, and hardcoding min_samples=10
      // broke that invariant when we lowered MIN_CALLS_FOR_PROPOSAL.
      const sampleSize = Math.min(50, latencies.length);
      const minSamples = Math.min(10, sampleSize);

      const brief: ExperimentBrief = {
        slug,
        name: `Latency probe: ${model}`,
        hypothesis: `${model} p50 latency stays below ${warnMs}ms on the rolling ${SAMPLE_WINDOW}-call window.`,
        everyMs: 30 * 60 * 1000, // 30m default cadence
        template: 'model_latency_probe',
        params: {
          model_id: model,
          sample_size: sampleSize,
          warn_latency_ms: warnMs,
          fail_latency_ms: failMs,
          min_samples: minSamples,
        } satisfies ModelLatencyProbeParams,
      };
      proposals.push(brief);
    }

    // 3. Rule 2 — migration schema probes. Code-reading rule:
    //    scan src/db/migrations/*.sql, extract CREATE TABLE names,
    //    emit one brief per migration file (newest first), capped
    //    per tick. Dedupe is handled by the same slug-collision
    //    mechanism Rule 1 uses.
    const migrationSummary = this.proposeMigrationSchemaProbes(
      proposals,
      existingProposals,
    );

    // 4. Rule 3 — toolchain singleton probes. Three fixed slugs that
    //    model the developer workflow: typecheck, lint, tests. Each is
    //    proposed once; dedupe prevents re-emission after that.
    const toolchainSummary = this.proposeToolchainSingletons(
      proposals,
      existingProposals,
    );

    // 5. Rule 4 — missing tool test coverage probes. Scans
    //    src/orchestrator/tools/*.ts, compares against __tests__/, and
    //    proposes a subprocess probe for each uncovered tool (cap 3/tick).
    const toolTestSummary = this.proposeMissingToolTestProbes(
      proposals,
      existingProposals,
    );

    // 6. Rule 5 — LLM-creative proposals. Fires only when rules 1-4
    //    return zero new briefs. Expensive (one LLM call) but rare —
    //    once the deterministic rules have exhausted what they can
    //    derive from code and traffic, the model gets the mic.
    const rule5Summary = proposals.length === 0
      ? await this.proposeViaLlm(proposals, existingProposals, ctx)
      : { fired: false, skipped_reason: 'rules_1_to_4_produced_proposals', new_proposals: 0 };

    const evidence: ProposalGeneratorEvidence = {
      inspected_models: byModel.size,
      existing_proposals: existingProposals.size,
      new_proposals: proposals.length,
      skipped_due_to_low_samples: skippedLowSamples,
      migrations_scanned: migrationSummary.migrations_scanned,
      migration_files_with_tables: migrationSummary.migration_files_with_tables,
      new_migration_proposals: migrationSummary.new_migration_proposals,
      migration_repo_root_unavailable: migrationSummary.repo_root_unavailable,
      new_toolchain_proposals: toolchainSummary.new_toolchain_proposals,
      tool_handlers_scanned: toolTestSummary.tool_handlers_scanned,
      tool_handlers_missing_tests: toolTestSummary.tool_handlers_missing_tests,
      new_tool_test_proposals: toolTestSummary.new_tool_test_proposals,
      rule5_fired: rule5Summary.fired,
      rule5_skipped_reason: rule5Summary.skipped_reason,
      new_llm_authored_proposals: rule5Summary.new_proposals,
      proposals,
    };

    const allSignals = [byModel.size, migrationSummary.migrations_scanned, toolTestSummary.tool_handlers_scanned];
    const anySignal = allSignals.some((n) => n > 0);
    const summary = !anySignal && toolchainSummary.new_toolchain_proposals === 0
      ? 'no llm_calls rows and no migrations readable — nothing to propose'
      : proposals.length === 0
        ? `inspected ${byModel.size} model(s) + ${migrationSummary.migrations_scanned} migration(s) + ${toolTestSummary.tool_handlers_scanned} tool(s), nothing new to propose (${existingProposals.size} already covered)`
        : `inspected ${byModel.size} model(s) + ${migrationSummary.migrations_scanned} migration(s) + ${toolTestSummary.tool_handlers_scanned} tool(s), generated ${proposals.length} new proposal(s)`;

    return {
      subject: null,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ProposalGeneratorEvidence;
    // Warning only when ALL data sources are silent: no LLM traffic,
    // no migration files readable (implies no repo root), no tool
    // handlers found, AND no toolchain singletons were newly proposed
    // (implies they're all already in the ledger — that's fine, but if
    // EVERYTHING is zero the generator has no signals at all).
    // In steady state (all covered) inspected_models and
    // migrations_scanned will still be > 0 so this branch stays quiet.
    if (
      ev.inspected_models === 0 &&
      ev.migrations_scanned === 0 &&
      ev.tool_handlers_scanned === 0 &&
      ev.new_toolchain_proposals === 0
    ) {
      return 'warning';
    }
    return 'pass';
  }

  /**
   * Writes each new brief as its own self_findings row with
   * category='experiment_proposal' + subject=`proposal:<slug>`.
   * The author experiment (Phase 7-D) polls these rows to pick up
   * work. Briefs are stored as JSON in the evidence column so the
   * ledger stays queryable and the author can deserialize cleanly.
   */
  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as ProposalGeneratorEvidence;
    if (ev.proposals.length === 0) return null;

    const proposalFindingIds: string[] = [];
    for (const brief of ev.proposals) {
      try {
        const id = await writeFinding(ctx.db, {
          experimentId: this.id,
          category: 'experiment_proposal',
          subject: `proposal:${brief.slug}`,
          hypothesis: `Proposed new experiment: ${brief.name}`,
          verdict: 'warning',
          summary: `new proposal: ${brief.slug} (${brief.template})`,
          evidence: {
            is_experiment_proposal: true,
            brief,
            claimed: false,
          },
          interventionApplied: null,
          ranAt: new Date().toISOString(),
          durationMs: 0,
        });
        proposalFindingIds.push(id);
      } catch {
        // Best effort; next run will pick up anything we missed.
      }
    }

    if (proposalFindingIds.length === 0) return null;

    return {
      description: `wrote ${proposalFindingIds.length} experiment proposal(s) to ledger`,
      details: {
        proposal_finding_ids: proposalFindingIds,
        proposal_count: proposalFindingIds.length,
        slugs: ev.proposals.map((p) => p.slug),
      },
    };
  }

  /**
   * Rule 5 — LLM-creative proposals.
   *
   * Fires only when Rules 1-4 produced zero new briefs. Builds a
   * compact context pack (recent findings from the loop's core
   * experiments + a list of slugs already covered + a roadmap
   * excerpt) and asks the model to propose 1-3 novel experiments
   * as a JSON array. Each accepted brief is pushed onto the
   * shared `proposals` array as template='llm_authored_probe'
   * so ExperimentAuthor's authorViaLlm path drafts the file.
   *
   * Fails closed: missing modelRouter, model error, parse error,
   * or all-invalid briefs leave `proposals` empty and return a
   * skipped_reason for evidence.
   */
  private async proposeViaLlm(
    proposals: ExperimentBrief[],
    existingProposals: Set<string>,
    ctx: ExperimentContext,
  ): Promise<{ fired: boolean; skipped_reason: string | null; new_proposals: number }> {
    if (!ctx.engine?.modelRouter) {
      return { fired: false, skipped_reason: 'no_model_router', new_proposals: 0 };
    }

    const status = getSelfCommitStatus();
    const repoRoot = status.repoRoot;
    const existingSlugs = repoRoot ? listExperimentBasenames(repoRoot) : [];
    const roadmapCtx = repoRoot ? loadRoadmapContext(repoRoot) : null;

    const findingsSummary: string[] = [];
    for (const expId of RULE5_CONTEXT_EXPERIMENTS) {
      let rows: Finding[] = [];
      try {
        rows = await ctx.recentFindings(expId, RULE5_FINDINGS_PER_EXPERIMENT);
      } catch {
        continue;
      }
      for (const f of rows) {
        const summary = (f.summary ?? '').slice(0, 200);
        findingsSummary.push(
          `  - [${expId}] ${f.verdict}: ${summary}`,
        );
      }
    }

    // Tier-3 wiring: pull the latest research + self-observation rows
    // out of the KB so the proposal LLM can read what ohwow has been
    // studying + how the loop has been behaving. Kept deliberately
    // small — too much context dilutes the ask, and the KB has a
    // stable short-form representation per source_type.
    const researchContext = await readRecentKbByType(ctx, 'arxiv', RULE5_ARXIV_LIMIT);
    const selfObsContext = await readRecentKbByType(ctx, 'self-observation', RULE5_SELF_OBS_LIMIT);
    const paperGapContext = await readLatestPaperGaps(ctx);

    const coveredList = Array.from(existingProposals)
      .concat(existingSlugs)
      .sort()
      .slice(0, 200)
      .join(', ');

    const system =
      'You propose novel self-bench experiment briefs for a local-first ' +
      'AI runtime\'s autonomous observation loop. Return ONLY a JSON array ' +
      'of 1 to 3 briefs. No markdown fences, no commentary. Each brief is ' +
      'an object with: slug (kebab-case, 1-50 chars, letter-start), name ' +
      '(<=200 chars), hypothesis (<=500 chars), everyMs (60000..86400000), ' +
      'probe_description (40..2000 chars; prose describing what to measure ' +
      'and how, including which tables/files/metrics to read), category ' +
      "(one of: 'model_health', 'tool_reliability', 'data_freshness', 'other'), " +
      'and optionally cites_papers (array of up to 3 arXiv ids or paper ' +
      'identifiers the brief draws on — empty or omitted when no paper ' +
      'influenced the design). ' +
      'Rules: propose read-only observation probes; no writes, no subprocess ' +
      'spawns unless the category is tool_reliability; do not duplicate ' +
      'slugs already covered; each probe must target something concrete ' +
      'the loop can observe via ctx.db or fs. When a paper from ' +
      '<research_papers> directly informs the brief, list its arXiv id in ' +
      'cites_papers — that produces a Cites-Research-Paper commit trailer ' +
      'so operators can measure whether paper-attributed probes hold. ' +
      'Prefer briefs that target tokens from <paper_gaps> when present — ' +
      'those are techniques the papers discuss that do not yet appear in ' +
      'the codebase, so probing them has the highest learning yield.';

    const promptParts: string[] = [];
    promptParts.push('<already_covered_slugs>');
    promptParts.push(coveredList || '(none)');
    promptParts.push('</already_covered_slugs>');
    if (findingsSummary.length > 0) {
      promptParts.push('');
      promptParts.push('<recent_findings>');
      promptParts.push(...findingsSummary);
      promptParts.push('</recent_findings>');
    }
    if (roadmapCtx) {
      promptParts.push('');
      promptParts.push('<autonomy_roadmap excerpt="Known Gaps + Active Focus">');
      promptParts.push(roadmapCtx);
      promptParts.push('</autonomy_roadmap>');
    }
    if (researchContext.length > 0) {
      promptParts.push('');
      promptParts.push('<research_papers source="arxiv via research-ingest-probe">');
      for (const r of researchContext) {
        promptParts.push(`  - id=${r.paper_id} title="${r.title.slice(0, 140)}"`);
        if (r.snippet) promptParts.push(`    abstract: ${r.snippet}`);
      }
      promptParts.push('</research_papers>');
    }
    if (selfObsContext.length > 0) {
      promptParts.push('');
      promptParts.push('<self_observations source="observation-probe, state changes only">');
      for (const r of selfObsContext) {
        promptParts.push(`  - ${r.title}`);
        if (r.snippet) promptParts.push(`    ${r.snippet}`);
      }
      promptParts.push('</self_observations>');
    }
    if (paperGapContext && (paperGapContext.aggregate.length > 0 || paperGapContext.papers.length > 0)) {
      promptParts.push('');
      promptParts.push('<paper_gaps source="code-paper-compare-probe, tokens absent from repo">');
      if (paperGapContext.aggregate.length > 0) {
        const topAgg = paperGapContext.aggregate
          .slice(0, RULE5_GAP_AGGREGATE_LIMIT)
          .map((g) => `${g.token}(${g.papers})`)
          .join(', ');
        promptParts.push(`  aggregate_tokens (token(paper_count)): ${topAgg}`);
      }
      for (const p of paperGapContext.papers.slice(0, RULE5_GAP_PAPER_LIMIT)) {
        promptParts.push(
          `  - paper=${p.paper_id} gap_ratio=${p.gap_ratio.toFixed(2)} gaps=[${p.gap_concepts.join(', ')}]`,
        );
      }
      promptParts.push('</paper_gaps>');
    }
    promptParts.push('');
    promptParts.push(
      'Propose up to ' + MAX_LLM_PROPOSALS_PER_TICK + ' new experiments. ' +
      'Return the JSON array now.',
    );

    const llm = await runLlmCall(
      {
        modelRouter: ctx.engine.modelRouter!,
        db: ctx.db,
        workspaceId: ctx.workspaceId,
      },
      {
        purpose: 'reasoning',
        system,
        prompt: promptParts.join('\n'),
        max_tokens: 4096,
        temperature: 0,
      },
    );
    if (!llm.ok) {
      return { fired: true, skipped_reason: `llm_error:${llm.error}`, new_proposals: 0 };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFences(llm.data.text));
    } catch (err) {
      return {
        fired: true,
        skipped_reason: `parse_error:${err instanceof Error ? err.message : String(err)}`,
        new_proposals: 0,
      };
    }
    if (!Array.isArray(parsed)) {
      return { fired: true, skipped_reason: 'not_an_array', new_proposals: 0 };
    }

    let newCount = 0;
    for (const raw of parsed.slice(0, MAX_LLM_PROPOSALS_PER_TICK)) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      if (
        typeof rec.slug !== 'string' ||
        typeof rec.name !== 'string' ||
        typeof rec.hypothesis !== 'string' ||
        typeof rec.everyMs !== 'number' ||
        typeof rec.probe_description !== 'string' ||
        typeof rec.category !== 'string'
      ) {
        continue;
      }
      if (existingProposals.has(rec.slug)) continue;
      // cites_papers: optional, tolerant of missing / wrong type. Keep
      // only string entries, cap at 3, strip empties. A malformed
      // value doesn't invalidate the brief — the rest of the brief is
      // still useful without a citation trailer.
      const rawCites = Array.isArray(rec.cites_papers) ? rec.cites_papers : [];
      const citesPapers = rawCites
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, 3);
      const params: LlmAuthoredProbeParams = {
        probe_description: rec.probe_description,
        category: rec.category as LlmAuthoredProbeParams['category'],
      };
      if (citesPapers.length > 0) params.cites_papers = citesPapers;
      const brief: ExperimentBrief = {
        slug: rec.slug,
        name: rec.name,
        hypothesis: rec.hypothesis,
        everyMs: rec.everyMs > 0 ? rec.everyMs : LLM_AUTHORED_PROBE_EVERY_MS,
        template: 'llm_authored_probe',
        params,
      };
      if (validateBrief(brief) !== null) continue;
      proposals.push(brief);
      existingProposals.add(brief.slug);
      newCount += 1;
    }

    return {
      fired: true,
      skipped_reason: newCount === 0 ? 'all_briefs_invalid_or_duplicate' : null,
      new_proposals: newCount,
    };
  }

  /**
   * Read every existing proposal slug from the last
   * DEDUPE_WINDOW_DAYS so we don't re-propose something we (or a
   * previous author run) already handled. A slug collision is the
   * dedupe key — once the author commits an experiment, it stops
   * being a "new model" because the llm_calls query still sees its
   * traffic but the proposal dedupe catches the match.
   */
  private async readExistingProposalSlugs(
    ctx: ExperimentContext,
  ): Promise<Set<string>> {
    const since = new Date(
      Date.now() - DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    try {
      const { data } = await ctx.db
        .from<{ subject: string; ran_at: string }>('self_findings')
        .select('subject, ran_at')
        .eq('category', 'experiment_proposal')
        .gte('ran_at', since)
        .limit(500);
      const rows = (data ?? []) as Array<{ subject: string | null }>;
      const set = new Set<string>();
      for (const row of rows) {
        if (row.subject && row.subject.startsWith('proposal:')) {
          set.add(row.subject.slice('proposal:'.length));
        }
      }
      return set;
    } catch {
      return new Set();
    }
  }

  /**
   * Rule 2 — RETIRED 2026-04-16.
   *
   * Migration schema probes used to be authored one-at-a-time by the
   * autonomous loop: this method would scan src/db/migrations/*.sql,
   * emit briefs for migrations with novel tables, and the author would
   * commit a single-row append to migration-schema-registry.ts per
   * brief. The work was purely deterministic (fs + regex) but
   * consumed an entire commit cycle (LLM tick, typecheck, husky hook)
   * per migration.
   *
   * scripts/regen-migration-schema-registry.mjs now owns this in
   * under a second, with a pre-commit gate that refuses to land a
   * .sql migration without a registry update. Keeping the method as
   * a zero-shaped stub preserves the evidence field shape the rest
   * of the probe code reads without needing structural changes.
   */
  private proposeMigrationSchemaProbes(
    _proposals: ExperimentBrief[],
    _existingProposals: Set<string>,
  ): {
    migrations_scanned: number;
    migration_files_with_tables: number;
    new_migration_proposals: number;
    repo_root_unavailable: boolean;
  } {
    return {
      migrations_scanned: 0,
      migration_files_with_tables: 0,
      new_migration_proposals: 0,
      repo_root_unavailable: false,
    };
  }

  /**
   * Rule 3 — toolchain singleton probes.
   * Proposes exactly three fixed experiments: typecheck, lint, tests.
   * These model the developer workflow so the ledger accumulates a
   * continuous pass/fail history for each tool without a human watching
   * a terminal. Once all three slugs are in the ledger the dedupe check
   * silently drops them every subsequent tick — zero overhead at steady
   * state.
   */
  private proposeToolchainSingletons(
    proposals: ExperimentBrief[],
    existingProposals: Set<string>,
  ): { new_toolchain_proposals: number } {
    let count = 0;
    for (const tc of TOOLCHAIN_EXPERIMENTS) {
      if (existingProposals.has(tc.slug)) continue;

      const brief: ExperimentBrief = {
        slug: tc.slug,
        name: tc.name,
        hypothesis: tc.hypothesis,
        everyMs: tc.everyMs,
        template: 'subprocess_health_probe',
        params: {
          command: tc.command,
          description: tc.description,
          capture_lines: 50,
          timeout_ms: tc.timeoutMs,
        } satisfies SubprocessHealthProbeParams,
      };

      // validateBrief is a safety net; params are hardcoded so this
      // should never fail in practice.
      if (validateBrief(brief) !== null) continue;

      proposals.push(brief);
      existingProposals.add(tc.slug);
      count += 1;
    }
    return { new_toolchain_proposals: count };
  }

  /**
   * Rule 4 — existing tool test coverage probes.
   * Scans src/orchestrator/tools/__tests__/*.test.ts for test files
   * that already exist and proposes a subprocess_health_probe for
   * each one that doesn't already have a proposal. Running a real
   * test file is useful: it tells the ledger whether those tests
   * are currently passing or broken.
   *
   * Previously this rule scanned tool source files, found ones
   * without a matching test, and proposed "run the missing file."
   * That was structurally wrong — vitest on a non-existent file
   * exits non-zero, so every generated probe immediately judged
   * 'fail' forever. The right signal for "this tool has no tests"
   * is a coverage-gap finding from a dedicated audit experiment,
   * not a probe that runs ghosts.
   *
   * Alphabetical ordering, capped at MAX_TOOL_TEST_PROPOSALS_PER_TICK
   * per tick, same dedupe logic as Rules 2 and 3.
   */
  private proposeMissingToolTestProbes(
    proposals: ExperimentBrief[],
    existingProposals: Set<string>,
  ): {
    tool_handlers_scanned: number;
    tool_handlers_missing_tests: number;
    new_tool_test_proposals: number;
  } {
    const status = getSelfCommitStatus();
    if (!status.repoRoot) {
      return { tool_handlers_scanned: 0, tool_handlers_missing_tests: 0, new_tool_test_proposals: 0 };
    }

    const testsDir = path.join(
      status.repoRoot,
      'src',
      'orchestrator',
      'tools',
      '__tests__',
    );

    // Collect existing test file basenames (without .test.ts extension).
    let testFiles: string[];
    try {
      testFiles = fs
        .readdirSync(testsDir)
        .filter((n) => n.endsWith('.test.ts'))
        .map((n) => n.replace(/\.test\.ts$/, ''))
        .sort(); // alphabetical
    } catch {
      // __tests__ dir may not exist yet — no proposals
      return { tool_handlers_scanned: 0, tool_handlers_missing_tests: 0, new_tool_test_proposals: 0 };
    }

    let newCount = 0;

    for (const name of testFiles) {
      // Already at the per-tick cap — stop proposing but finish the loop count.
      if (newCount >= MAX_TOOL_TEST_PROPOSALS_PER_TICK) break;

      // Build slug: "toolchain-tool-test-<sanitized-name>"
      const sanitized = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const slug = `toolchain-tool-test-${sanitized}`;
      if (slug.length > SLUG_MAX_LENGTH) continue;
      if (existingProposals.has(slug)) continue;

      const testRelPath = `src/orchestrator/tools/__tests__/${name}.test.ts`;

      const brief: ExperimentBrief = {
        slug,
        name: `Tool test coverage: ${name}`,
        hypothesis: `${name} tests at ${testRelPath} pass on every run.`,
        everyMs: TOOL_TEST_PROBE_EVERY_MS,
        template: 'subprocess_health_probe',
        params: {
          command: `npx vitest run ${testRelPath}`,
          description: `Test coverage probe for ${name}`,
          capture_lines: 30,
          timeout_ms: 60 * 1000, // 60s per tool test run
        } satisfies SubprocessHealthProbeParams,
      };

      if (validateBrief(brief) !== null) continue;

      proposals.push(brief);
      existingProposals.add(slug);
      newCount += 1;
    }

    return {
      // tool_handlers_scanned now means "test files found", keeping the
      // field name stable so existing ledger consumers don't break.
      tool_handlers_scanned: testFiles.length,
      // No longer meaningful (we only scan existing tests, not gaps).
      // Keep the field for schema compatibility; always 0.
      tool_handlers_missing_tests: 0,
      new_tool_test_proposals: newCount,
    };
  }
}

/**
 * Enumerate .ts files under src/self-bench/experiments/ so Rule 5 can
 * tell the model which slugs are already implemented. Mirrors the
 * pattern used by roadmap-updater.
 */
function listExperimentBasenames(repoRoot: string): string[] {
  const dir = path.join(repoRoot, 'src/self-bench/experiments');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Load a compact excerpt from AUTONOMY_ROADMAP.md (sections "Known
 * Gaps" and "Active Focus") so Rule 5's prompt grounds the model in
 * the loop's current convergence state. Best-effort — missing file
 * or unreadable sections return null and Rule 5 proceeds without it.
 */
/**
 * Pull recent KB entries of a single source_type into a compact
 * prompt-ready form. source_type='arxiv' yields research papers the
 * research-ingest-probe has fetched; source_type='self-observation'
 * yields snapshot summaries of the autonomous loop. Both flow into
 * the Rule 5 prompt so the proposal LLM sees both "what the field
 * is producing" and "what this loop has been doing lately."
 *
 * Ordered by most recent first; snippet is the first ~360 chars of
 * compiled_text (the original abstract or observation summary).
 * Extracts the arXiv id from the title's `[arxiv/cat]` prefix or
 * falls back to the source_url path when absent.
 */
async function readRecentKbByType(
  ctx: ExperimentContext,
  sourceType: 'arxiv' | 'self-observation',
  limit: number,
): Promise<Array<{ paper_id: string; title: string; snippet: string }>> {
  try {
    const { data } = await ctx.db
      .from<{ title: string; compiled_text: string | null; source_url: string | null; created_at: string }>(
        'agent_workforce_knowledge_documents',
      )
      .select('title, compiled_text, source_url, created_at')
      .eq('workspace_id', ctx.workspaceId)
      .eq('source_type', sourceType)
      .order('created_at', { ascending: false })
      .limit(limit);
    const rows = (data ?? []) as Array<{
      title: string;
      compiled_text: string | null;
      source_url: string | null;
    }>;
    return rows.map((r) => {
      const paperId = sourceType === 'arxiv' && r.source_url
        ? (r.source_url.split('/').pop() ?? r.source_url)
        : (r.source_url ?? 'unknown');
      const snippet = (r.compiled_text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, RULE5_KB_SNIPPET_CHARS);
      return { paper_id: paperId, title: r.title, snippet };
    });
  } catch {
    return [];
  }
}

/**
 * Pull the latest `code-paper-compare-probe` finding's gap signal.
 * Returns null if the probe has never run (new workspace). The shape
 * is flattened for the prompt: aggregate tokens are the "common to
 * many papers" signal; per-paper entries show which concrete paper
 * introduced a given gap so the LLM can anchor a citation.
 */
async function readLatestPaperGaps(
  ctx: ExperimentContext,
): Promise<
  | {
      aggregate: Array<{ token: string; papers: number }>;
      papers: Array<{ paper_id: string; title: string; gap_concepts: string[]; gap_ratio: number }>;
    }
  | null
> {
  try {
    const { data } = await ctx.db
      .from<{ evidence: string }>('self_findings')
      .select('evidence')
      .eq('experiment_id', 'code-paper-compare-probe')
      .order('ran_at', { ascending: false })
      .limit(1);
    const rows = (data ?? []) as Array<{ evidence: string }>;
    if (rows.length === 0) return null;
    const ev = JSON.parse(rows[0].evidence) as {
      aggregate_gap_tokens?: Array<{ token: string; papers: number }>;
      entries?: Array<{ paper_id: string; title: string; gap_concepts: string[]; gap_ratio: number }>;
    };
    const aggregate = Array.isArray(ev.aggregate_gap_tokens) ? ev.aggregate_gap_tokens : [];
    // Only include papers that actually have unresolved gap concepts —
    // the LLM doesn't need to see "this paper has no gaps" noise.
    const papers = (ev.entries ?? [])
      .filter((e) => e.gap_concepts && e.gap_concepts.length > 0)
      .sort((a, b) => b.gap_ratio - a.gap_ratio);
    return { aggregate, papers };
  } catch {
    return null;
  }
}

function loadRoadmapContext(repoRoot: string): string | null {
  try {
    const full = fs.readFileSync(path.join(repoRoot, 'AUTONOMY_ROADMAP.md'), 'utf-8');
    const sections: string[] = [];
    const gapMatch = full.match(/## 2\. Known Gaps[\s\S]*?(?=## \d|$)/);
    const focusMatch = full.match(/## 3\. Active Focus[\s\S]*?(?=## \d|$)/);
    if (gapMatch) sections.push(gapMatch[0].trim());
    if (focusMatch) sections.push(focusMatch[0].trim());
    if (sections.length === 0) return null;
    return sections.join('\n\n');
  } catch {
    return null;
  }
}
