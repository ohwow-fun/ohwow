/**
 * ModelHealthExperiment — first concrete Experiment.
 *
 * Wraps the E1 demotion cache (src/execution/agent-model-tiers.ts) as
 * a scheduled experiment so its outcome joins the findings ledger
 * alongside every other self-check. The probe fires the existing
 * refreshDemotedAgentModels(db) which is already safe to call on any
 * interval — it reads rolling 7-day llm_calls telemetry and updates
 * the module-level demoted set atomically. The experiment wraps that
 * side-effect in structure: a probe that captures the stats snapshot,
 * a judge that reads it, and an intervene that records what the
 * refresher actually changed.
 *
 * The refresher itself is the intervention (it demotes in place), so
 * intervene() doesn't need to DO anything — it just formats the
 * change for the ledger. A future version of this experiment could
 * compare before/after snapshots to compute exact delta; Phase 1 just
 * records the post-state.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import {
  refreshDemotedAgentModels,
  getAgentModelDemotionSnapshot,
} from '../../execution/agent-model-tiers.js';

interface ModelHealthEvidence extends Record<string, unknown> {
  demoted_models: string[];
  tracked_models: number;
  demoted_count: number;
  model_stats: Array<{ model: string; samples: number; toolCallRate: number; demoted: boolean }>;
  last_refresh_at: number;
}

export class ModelHealthExperiment implements Experiment {
  id = 'model-health';
  name = 'Agent FAST-tier model health';
  category = 'model_health' as const;
  hypothesis =
    'Every model eligible for the agent FAST tier reliably emits OpenAI-format tool_calls on work-shaped tasks (≥40% rate over ≥10 rolling samples).';
  cadence = { everyMs: 10 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    await refreshDemotedAgentModels(ctx.db);
    const snap = getAgentModelDemotionSnapshot();
    const stats = snap.stats.map((s) => ({
      model: s.model,
      samples: s.samples,
      toolCallRate: Math.round(s.toolCallRate * 100) / 100,
      demoted: snap.demoted.includes(s.model),
    }));

    const evidence: ModelHealthEvidence = {
      demoted_models: snap.demoted,
      tracked_models: snap.stats.length,
      demoted_count: snap.demoted.length,
      model_stats: stats,
      last_refresh_at: snap.lastRefreshAt,
    };

    const summary = snap.demoted.length === 0
      ? snap.stats.length === 0
        ? 'no rolling telemetry yet — probe produced zero samples'
        : `${snap.stats.length} model(s) tracked, all healthy`
      : `${snap.demoted.length} of ${snap.stats.length} tracked model(s) demoted: ${snap.demoted.join(', ')}`;

    return {
      subject: snap.demoted.length > 0 ? snap.demoted[0] : null,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ModelHealthEvidence;
    if (ev.tracked_models === 0) {
      // No rolling signal yet — warning, not fail. This fires on fresh
      // workspaces or right after a daemon restart before enough
      // agent tasks have landed telemetry rows.
      return 'warning';
    }
    if (ev.demoted_count === 0) return 'pass';
    // Any demotion means the demotion cache took action. That's a
    // warning, not a fail — the system self-healed. Only escalate to
    // fail when more than half of tracked models are demoted (system
    // is running out of healthy routing targets).
    if (ev.demoted_count * 2 > ev.tracked_models) return 'fail';
    return 'warning';
  }

  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    _ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as ModelHealthEvidence;
    if (ev.demoted_count === 0) return null;
    // The refresher already updated the module-level set in probe().
    // intervene() just structures the change for the ledger so the
    // upcoming re-promotion experiment can query "which models got
    // demoted when" by reading findings.
    return {
      description: `Demotion cache refreshed — ${ev.demoted_count} model(s) currently demoted from FAST tier`,
      details: {
        demoted_models: ev.demoted_models,
        demoted_count: ev.demoted_count,
        tracked_models: ev.tracked_models,
      },
    };
  }
}
