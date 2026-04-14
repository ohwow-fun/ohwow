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
 * For Phase 7, the proposal generator is narrow on purpose. It
 * runs one rule:
 *
 *   Rule 1 (model_latency_probe proposal):
 *     For each model_id in llm_calls that has at least MIN_SAMPLES
 *     recent calls AND no existing experiment with
 *     slug=`model-latency-<sanitized-id>` (checked via existing
 *     findings with that subject), propose a new latency probe
 *     targeted at that model. Thresholds are derived from the
 *     observed latency distribution — warn at p90, fail at p99 —
 *     so the generated experiment's alert shape matches the
 *     baseline at generation time.
 *
 * Future rules could cover: per-tool reliability probes,
 * per-trigger-type coverage probes, per-agent-config health probes,
 * per-provider cost probes. Each additional rule is another pass
 * through probe() that adds to the proposals list. This commit
 * keeps Rule 1 only.
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
  ModelLatencyProbeParams,
} from '../experiment-template.js';
import { writeFinding } from '../findings-store.js';

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
  // 10m cadence + runOnBoot: true so the proposal generator fires
  // every 10 minutes (not the prior hourly) and also on the first
  // tick after daemon restart. The generator is read-only — probe
  // + intervene just scan llm_calls and write briefs to the ledger.
  // No git mutation, no LLM, no cost. Safe to run frequently.
  cadence = { everyMs: 10 * 60 * 1000, runOnBoot: true };

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

      const brief: ExperimentBrief = {
        slug,
        name: `Latency probe: ${model}`,
        hypothesis: `${model} p50 latency stays below ${warnMs}ms on the rolling ${SAMPLE_WINDOW}-call window.`,
        everyMs: 30 * 60 * 1000, // 30m default cadence
        template: 'model_latency_probe',
        params: {
          model_id: model,
          sample_size: Math.min(50, latencies.length),
          warn_latency_ms: warnMs,
          fail_latency_ms: failMs,
          min_samples: 10,
        } satisfies ModelLatencyProbeParams,
      };
      proposals.push(brief);
    }

    const evidence: ProposalGeneratorEvidence = {
      inspected_models: byModel.size,
      existing_proposals: existingProposals.size,
      new_proposals: proposals.length,
      skipped_due_to_low_samples: skippedLowSamples,
      proposals,
    };

    const summary =
      byModel.size === 0
        ? 'no llm_calls rows in the last 7 days — nothing to propose'
        : proposals.length === 0
          ? `inspected ${byModel.size} model(s), nothing new to propose (${existingProposals.size} already covered)`
          : `inspected ${byModel.size} model(s), generated ${proposals.length} new proposal(s)`;

    return {
      subject: null,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ProposalGeneratorEvidence;
    // No models seen = warning (the generator can't do its job)
    if (ev.inspected_models === 0) return 'warning';
    // Always pass when we're producing proposals — they're not
    // problems, they're work queue entries for the author.
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
}
