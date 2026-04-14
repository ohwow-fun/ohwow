/**
 * ProviderAvailabilityExperiment — Phase 8-A.1
 *
 * Watches LLM provider health over a rolling 1-hour window by reading
 * the `llm_calls` table grouped by provider. Counts call success vs
 * failure (success=0 rows) and emits:
 *
 *   pass    — all providers better than 5% failure rate (or no calls)
 *   warning — any provider 5–20% failure rate in the last N calls
 *   fail    — any provider >20% failure rate in the last N calls
 *
 * Why this matters: a provider going 429/500 cascades to retry storms
 * that make internal toolchain tests time out, making it look like
 * code is broken when it's the provider. Currently invisible.
 *
 * No intervene — routing adaptation is Phase 8-B; this experiment
 * supplies the signal that will drive it.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

const ROLLING_WINDOW_HOURS = 1;
/** Max rows fetched from llm_calls in the window — bounds the probe cost. */
const WINDOW_SCAN_LIMIT = 1000;
const WARNING_FAILURE_RATE = 0.05; // 5%
const FAIL_FAILURE_RATE = 0.20; // 20%

interface LlmCallRow {
  provider: string;
  success: number;
}

interface ProviderStats {
  provider: string;
  total_calls: number;
  failed_calls: number;
  failure_rate: number;
}

interface ProviderAvailabilityEvidence extends Record<string, unknown> {
  window_hours: number;
  providers: ProviderStats[];
  worst_provider: string | null;
  worst_failure_rate: number;
  total_calls_in_window: number;
}

export class ProviderAvailabilityExperiment implements Experiment {
  id = 'provider-availability';
  name = 'LLM provider availability monitor';
  category = 'model_health' as const;
  hypothesis =
    'All registered LLM providers maintain <5% failure rate over a rolling 1-hour window. Elevated failure rates surface before they cascade to agent retry storms.';
  cadence = { everyMs: 15 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const windowStart = new Date(
      Date.now() - ROLLING_WINDOW_HOURS * 60 * 60 * 1000,
    ).toISOString();

    // Fetch recent llm_calls in the window, ordered by newest-first.
    // We only need provider + success to compute failure rates.
    const { data } = await ctx.db
      .from<LlmCallRow>('llm_calls')
      .select('provider, success')
      .eq('workspace_id', ctx.workspaceId)
      .gte('created_at', windowStart)
      .order('created_at', { ascending: false })
      .limit(WINDOW_SCAN_LIMIT);

    const rows = (data ?? []) as LlmCallRow[];

    // Group by provider in JS — no GROUP BY in the query builder.
    const byProvider = new Map<string, { total: number; failed: number }>();
    for (const row of rows) {
      const entry = byProvider.get(row.provider) ?? { total: 0, failed: 0 };
      entry.total++;
      if (row.success === 0) entry.failed++;
      byProvider.set(row.provider, entry);
    }

    const providers: ProviderStats[] = Array.from(byProvider.entries()).map(
      ([provider, counts]) => ({
        provider,
        total_calls: counts.total,
        failed_calls: counts.failed,
        failure_rate: counts.total > 0 ? counts.failed / counts.total : 0,
      }),
    );

    // Worst failure rate first
    providers.sort((a, b) => b.failure_rate - a.failure_rate);

    const worst = providers[0] ?? null;
    const worstRate = worst?.failure_rate ?? 0;
    const worstProvider = worst?.provider ?? null;

    const evidence: ProviderAvailabilityEvidence = {
      window_hours: ROLLING_WINDOW_HOURS,
      providers,
      worst_provider: worstProvider,
      worst_failure_rate: worstRate,
      total_calls_in_window: rows.length,
    };

    if (rows.length === 0) {
      return {
        subject: null,
        summary: `no llm_calls in the last ${ROLLING_WINDOW_HOURS}h`,
        evidence,
      };
    }

    const problemProviders = providers
      .filter((p) => p.failure_rate > 0)
      .map((p) => `${p.provider} ${(p.failure_rate * 100).toFixed(1)}% failed`);

    const summary =
      problemProviders.length > 0
        ? `provider failure rates: ${problemProviders.join(', ')}`
        : `all ${providers.length} provider(s) healthy (${rows.length} calls checked)`;

    return {
      subject: worstProvider,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ProviderAvailabilityEvidence;
    if (ev.total_calls_in_window === 0) return 'pass';
    if (ev.worst_failure_rate >= FAIL_FAILURE_RATE) return 'fail';
    if (ev.worst_failure_rate >= WARNING_FAILURE_RATE) return 'warning';
    return 'pass';
  }
}
