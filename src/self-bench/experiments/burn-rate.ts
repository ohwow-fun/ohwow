/**
 * BurnRateExperiment — always-on cost/spend summary.
 *
 * Surfaces daily llm_calls burn into self_findings so cold-prompt
 * readers (and the strategist) can answer "what's the spend?" without
 * needing a live dashboard query. Distinct from AgentTaskCostWatcher,
 * which only fires against an operator-configured goal — this one
 * always emits, every cadence tick, so the number is always one query
 * away from whatever organ wants to consume it.
 *
 * Emits subject = 'meta:burn-rate' with evidence:
 *   total_cents_today, total_cents_yesterday, delta_cents,
 *   total_tokens_today, local_call_ratio (provider in {ollama, local}),
 *   top_model_by_cost (model, cents).
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

interface LlmCallRow {
  workspace_id: string;
  provider: string;
  model: string;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

interface BurnEvidence extends Record<string, unknown> {
  total_cents_today: number;
  total_cents_yesterday: number;
  delta_cents: number;
  total_tokens_today: number;
  call_count_today: number;
  local_call_ratio: number;
  top_model_by_cost: { model: string; cents: number } | null;
  window_hours: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL_PROVIDERS = new Set(['ollama', 'local']);

export class BurnRateExperiment implements Experiment {
  readonly id = 'burn-rate';
  readonly name = 'Daily LLM burn rate summary';
  readonly category = 'other' as const;
  readonly hypothesis =
    'Daily LLM cost stays low by preferring local providers; day-over-day spend jumps are visible as positive delta_cents.';
  readonly cadence = { everyMs: 10 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const now = Date.now();
    const since48h = new Date(now - 2 * DAY_MS).toISOString();

    let rows: LlmCallRow[] = [];
    try {
      const { data } = await ctx.db
        .from<LlmCallRow>('llm_calls')
        .select('workspace_id, provider, model, cost_cents, input_tokens, output_tokens, created_at')
        .eq('workspace_id', ctx.workspaceId)
        .gte('created_at', since48h)
        .limit(20_000);
      rows = (data ?? []) as LlmCallRow[];
    } catch (err) {
      return {
        subject: 'meta:burn-rate',
        summary: `burn-rate probe failed to read llm_calls: ${err instanceof Error ? err.message : String(err)}`,
        evidence: {
          total_cents_today: 0,
          total_cents_yesterday: 0,
          delta_cents: 0,
          total_tokens_today: 0,
          call_count_today: 0,
          local_call_ratio: 0,
          top_model_by_cost: null,
          window_hours: 24,
          error: true,
        } satisfies BurnEvidence & { error: boolean },
      };
    }

    const todayCut = now - DAY_MS;
    let centsToday = 0;
    let centsYesterday = 0;
    let tokensToday = 0;
    let callsToday = 0;
    let localCallsToday = 0;
    const modelCostToday = new Map<string, number>();

    for (const r of rows) {
      const ts = new Date(r.created_at).getTime();
      if (Number.isNaN(ts)) continue;
      const cost = Number(r.cost_cents) || 0;
      if (ts >= todayCut) {
        centsToday += cost;
        tokensToday += (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0);
        callsToday += 1;
        if (LOCAL_PROVIDERS.has(r.provider)) localCallsToday += 1;
        modelCostToday.set(r.model, (modelCostToday.get(r.model) ?? 0) + cost);
      } else {
        centsYesterday += cost;
      }
    }

    let topModel: { model: string; cents: number } | null = null;
    for (const [model, cents] of modelCostToday) {
      if (!topModel || cents > topModel.cents) topModel = { model, cents };
    }

    const localRatio = callsToday > 0 ? localCallsToday / callsToday : 0;
    const deltaCents = centsToday - centsYesterday;

    const evidence: BurnEvidence = {
      total_cents_today: centsToday,
      total_cents_yesterday: centsYesterday,
      delta_cents: deltaCents,
      total_tokens_today: tokensToday,
      call_count_today: callsToday,
      local_call_ratio: Math.round(localRatio * 100) / 100,
      top_model_by_cost: topModel,
      window_hours: 24,
    };

    const deltaStr =
      deltaCents === 0
        ? 'flat'
        : `${deltaCents > 0 ? '+' : ''}${deltaCents}¢ vs yesterday`;
    const topStr = topModel ? `, top ${topModel.model} ${topModel.cents}¢` : '';
    const summary = `${centsToday}¢ today (${deltaStr}); ${callsToday} calls, ${Math.round(localRatio * 100)}% local${topStr}`;

    return { subject: 'meta:burn-rate', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as BurnEvidence & { error?: boolean };
    if (ev.error) return 'warning';
    // 500¢ = $5. Observer-only, no hard threshold today — warn on a
    // 3x day-over-day jump OR > 1000¢/day absolute. Fail is reserved
    // for situations an operator probably needs to see immediately:
    // >5000¢ in a single day would be a runaway loop.
    if (ev.total_cents_today > 5000) return 'fail';
    if (ev.total_cents_today > 1000) return 'warning';
    if (ev.total_cents_yesterday > 0 && ev.total_cents_today > 3 * ev.total_cents_yesterday)
      return 'warning';
    return 'pass';
  }
}
