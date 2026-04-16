/**
 * ExperimentCostObserverExperiment — per-experiment LLM cost rollup.
 *
 * Burn-rate already answers "what's the daily total spend?" but it's
 * blind to attribution: it can't tell the operator which experiment
 * is responsible for the spike. With migration 132, every llm_calls
 * row carries an experiment_id when the call originates from a probe
 * or intervene step. This observer joins llm_calls (cost side) with
 * self_findings (signal side) over a 14d window and surfaces:
 *
 *   - top_spenders[] — sorted by total_cents descending. Each entry
 *     carries cost, call count, and how many warning|fail findings
 *     the same experiment produced in the same window.
 *   - spending_without_signal[] — experiments where total_cents
 *     exceeds COST_FLOOR but warning_fail_count is zero. These are
 *     the cadence-tightening candidates the brief calls out.
 *
 * Verdict: warning when at least one experiment is in the
 * spending_without_signal bucket. Otherwise pass.
 *
 * Read-only / observer-only. The intervene hook is intentionally
 * absent — defunding an experiment is an operator decision, not an
 * autonomous one. The finding gives the operator the data; they
 * decide whether to tighten cadence, swap a model, or kill the
 * experiment.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 14 * DAY_MS;
/** Skip experiments under this cost — the noise floor. Below 10¢ over 14d isn't worth flagging. */
const COST_FLOOR_CENTS = 10;
/** Cap on top_spenders entries surfaced in the finding evidence. */
const TOP_N = 10;
/** Cap llm_calls rows pulled per probe. 14d × current rate (~300 calls/day) ≈ 4200; 20k is generous. */
const MAX_LLM_ROWS = 20_000;
/** Cap self_findings rows pulled per probe. */
const MAX_FINDING_ROWS = 50_000;

interface LlmCallRow {
  experiment_id: string | null;
  cost_cents: number;
  created_at: string;
}

interface FindingRow {
  experiment_id: string;
  verdict: string;
}

export interface ExperimentCostEntry {
  experiment_id: string;
  total_cents: number;
  call_count: number;
  warning_fail_count: number;
}

export interface ExperimentCostEvidence extends Record<string, unknown> {
  affected_files: string[];
  window_days: number;
  cost_floor_cents: number;
  experiments_observed: number;
  unattributed_cents: number;
  unattributed_calls: number;
  top_spenders: ExperimentCostEntry[];
  spending_without_signal: ExperimentCostEntry[];
}

export class ExperimentCostObserverExperiment implements Experiment {
  readonly id = 'experiment-cost-observer';
  readonly name = 'Per-experiment LLM cost rollup';
  readonly category = 'other' as const;
  readonly hypothesis =
    'A small number of self-bench experiments account for most LLM cost. Surfacing the top spenders alongside the warning|fail findings they produced gives the operator a direct ROI view: experiments spending without producing non-trivial signal are cadence-tightening or kill candidates. Read-only — defunding is an operator call, not autonomous.';
  readonly cadence = { everyMs: 60 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();

    let calls: LlmCallRow[] = [];
    try {
      const { data } = await ctx.db
        .from<LlmCallRow>('llm_calls')
        .select('experiment_id, cost_cents, created_at')
        .eq('workspace_id', ctx.workspaceId)
        .gte('created_at', since)
        .limit(MAX_LLM_ROWS);
      calls = (data ?? []) as LlmCallRow[];
    } catch (err) {
      return {
        subject: 'meta:experiment-cost',
        summary: `cost-observer probe failed to read llm_calls: ${err instanceof Error ? err.message : String(err)}`,
        evidence: emptyEvidence({ error: true }) as ExperimentCostEvidence,
      };
    }

    let findings: FindingRow[] = [];
    try {
      const { data } = await ctx.db
        .from<FindingRow>('self_findings')
        .select('experiment_id, verdict')
        .gte('ran_at', since)
        .in('verdict', ['warning', 'fail'])
        .limit(MAX_FINDING_ROWS);
      findings = (data ?? []) as FindingRow[];
    } catch {
      // Fail-soft: missing finding data just means warning_fail_count
      // shows 0 for everyone. The cost numbers are still useful.
      findings = [];
    }

    const warningFailByExperiment = new Map<string, number>();
    for (const f of findings) {
      const k = f.experiment_id;
      warningFailByExperiment.set(k, (warningFailByExperiment.get(k) ?? 0) + 1);
    }

    const costByExperiment = new Map<string, { total_cents: number; call_count: number }>();
    let unattributedCents = 0;
    let unattributedCalls = 0;
    for (const c of calls) {
      const cost = Number(c.cost_cents) || 0;
      const id = c.experiment_id;
      if (!id) {
        unattributedCents += cost;
        unattributedCalls += 1;
        continue;
      }
      const prev = costByExperiment.get(id) ?? { total_cents: 0, call_count: 0 };
      prev.total_cents += cost;
      prev.call_count += 1;
      costByExperiment.set(id, prev);
    }

    const entries: ExperimentCostEntry[] = [];
    for (const [experiment_id, agg] of costByExperiment) {
      entries.push({
        experiment_id,
        total_cents: agg.total_cents,
        call_count: agg.call_count,
        warning_fail_count: warningFailByExperiment.get(experiment_id) ?? 0,
      });
    }
    entries.sort((a, b) => b.total_cents - a.total_cents);

    const topSpenders = entries.slice(0, TOP_N);
    const spendingWithoutSignal = entries
      .filter((e) => e.total_cents >= COST_FLOOR_CENTS && e.warning_fail_count === 0)
      .slice(0, TOP_N);

    const evidence: ExperimentCostEvidence = {
      affected_files: [],
      window_days: WINDOW_MS / DAY_MS,
      cost_floor_cents: COST_FLOOR_CENTS,
      experiments_observed: entries.length,
      unattributed_cents: unattributedCents,
      unattributed_calls: unattributedCalls,
      top_spenders: topSpenders,
      spending_without_signal: spendingWithoutSignal,
    };

    const summary =
      spendingWithoutSignal.length === 0
        ? `${entries.length} experiment(s) tracked, top=${topSpenders[0]?.experiment_id ?? 'none'} ${topSpenders[0]?.total_cents ?? 0}¢; no spending-without-signal cases`
        : `${spendingWithoutSignal.length} experiment(s) spending without signal, top offender=${spendingWithoutSignal[0].experiment_id} ${spendingWithoutSignal[0].total_cents}¢ over ${WINDOW_MS / DAY_MS}d`;
    return { subject: 'meta:experiment-cost', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ExperimentCostEvidence & { error?: boolean };
    if (ev.error) return 'warning';
    return ev.spending_without_signal.length > 0 ? 'warning' : 'pass';
  }
}

function emptyEvidence(extra: Record<string, unknown>): ExperimentCostEvidence & Record<string, unknown> {
  return {
    affected_files: [],
    window_days: WINDOW_MS / DAY_MS,
    cost_floor_cents: COST_FLOOR_CENTS,
    experiments_observed: 0,
    unattributed_cents: 0,
    unattributed_calls: 0,
    top_spenders: [],
    spending_without_signal: [],
    ...extra,
  };
}
