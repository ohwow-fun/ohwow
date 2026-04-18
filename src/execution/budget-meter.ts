/**
 * Budget meter — per-workspace rolling daily spend tracker for the
 * autonomous LLM loop. Gap 13 (LLM budget enforcement) owns this.
 *
 * Reads llm_calls.cost_cents (already recorded by recordLlmCallTelemetry
 * in llm-organ.ts) and sums it from the start of the current UTC day to
 * answer: "how much has this workspace burned in autonomous LLM calls
 * today?". The middleware in budget-middleware.ts consults this meter
 * before dispatching a new call and may demote, pause, or halt based
 * on how close we are to the workspace's configured limit.
 *
 * Pricing note: llm_calls rows already carry a cost_cents value
 * populated by the provider at call time, so the meter does not
 * re-price. The PRICING_USD_PER_MTOK table below is kept as a
 * fallback / documentation surface for models whose provider returned
 * no cost (cost_cents=0). Any entry flagged with a FIXME means the
 * number is a defensive placeholder — refine against the official
 * price page when the next operator touches this file.
 *
 * Origin tagging (autonomous vs interactive) lives on the llm_calls row
 * as of migration 141. The meter filters to origin='autonomous' so
 * operator-initiated chat and manual tool invocations do not erode the
 * autonomous daily cap. Untagged rows (unchanged call sites) default to
 * 'autonomous' at insert time, so the cap stays conservative until the
 * interactive entry points are tagged in a follow-up round.
 *
 * ============================================================
 * INVARIANT: no Opus 4.7 tokenizer multiplier here. Do not add one.
 * ============================================================
 * Gap-13 historically listed a "Tokenizer-aware re-pricing for Opus 4.7
 * (1.0-1.35x inflation)" checkbox. The CASE-A finding (2026-04-18) is
 * that no multiplier is needed at this layer, because both sources of
 * truth already reflect the new tokenizer:
 *
 *   (a) Anthropic-native calls (`AnthropicProvider.createMessage*` in
 *       `src/execution/model-router.ts`) pull `input_tokens` /
 *       `output_tokens` straight from `response.usage.*` on the
 *       Anthropic SDK response. Those counts are produced by the
 *       server-side Opus 4.7 tokenizer — i.e. if the same prompt now
 *       costs 1.35x more tokens, the SDK already reports 1.35x the
 *       count. Multiplying again would double-count.
 *   (b) OpenRouter-routed calls (`OpenRouterProvider`) populate
 *       `costCents` directly from `data.usage.cost` on the invoice
 *       payload, which is the actual dollar amount OpenRouter bills.
 *       Re-pricing those rows would drift from the invoice of record.
 *
 * So the meter's contract is: trust cost_cents when present, otherwise
 * fall back to PRICING_USD_PER_MTOK * provider-native token counts.
 * Neither path wants a `applyTokenInflation(modelId, tokens)` wrapper.
 *
 * Out of scope for this invariant: `estimateTokens(ceil(len/4))` in
 * `src/orchestrator/context-budget.ts`. That heuristic is used for
 * context-window trimming decisions, not for spend accounting, so its
 * accuracy does not affect what this meter reports.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

/**
 * Origin of an LLM call for budget accounting. Interactive calls are
 * operator-initiated (chat, manual tool invocation) and are not gated
 * by the autonomous cap this round. Autonomous calls are anything the
 * daemon fires on its own — schedulers, self-bench, agent loops.
 */
export type CallOrigin = 'autonomous' | 'interactive';

/**
 * USD prices per million tokens, split by prompt vs completion. These
 * numbers are defensive placeholders for the fallback path only. The
 * meter prefers cost_cents that llm_calls already stores. When a row
 * has cost_cents=0 but we still want a non-zero spend signal, the
 * middleware may consult this table via `estimateCostUsdCents` below.
 *
 * INPUT CONTRACT (see gap-13 invariant at top of this file): the
 * inputTokens / outputTokens passed into estimateCostUsdCents are the
 * provider-native counts produced by the model's own tokenizer (e.g.
 * `response.usage.input_tokens` on the Anthropic SDK). They already
 * include the Opus 4.7 tokenizer change. Do NOT pre-inflate them with
 * a 1.0-1.35x multiplier here — the SDK already did it.
 *
 * FIXME(gap-13): refresh against the official price pages before the
 * next accuracy-sensitive consumer lands. Sources:
 *   - https://www.anthropic.com/pricing
 *   - https://openai.com/api/pricing
 *   - https://ai.google.dev/pricing
 *   Local ollama (llama3.1) priced at 0 deliberately — no API charge.
 */
export const PRICING_USD_PER_MTOK: Record<string, { prompt: number; completion: number }> = {
  'claude-sonnet-4-6':         { prompt: 3.00, completion: 15.00 },
  // Opus 4.7: rate card is $15 / $75 per MTok. The new tokenizer can
  // yield up to 1.35x more tokens for the same English text vs 4.6,
  // but that inflation is ALREADY reflected in the SDK-reported token
  // counts we multiply by — no separate correction here (gap-13 CASE-A).
  'claude-opus-4-7':           { prompt: 15.00, completion: 75.00 },
  'claude-haiku-4-5-20251001': { prompt: 0.80, completion: 4.00 },
  'gpt-5.4-pro':               { prompt: 5.00, completion: 25.00 },
  'gemini-3.1-pro':            { prompt: 1.25, completion: 5.00 },
  'llama3.1':                  { prompt: 0,    completion: 0    },
};

/**
 * Compute the UTC-midnight ISO timestamp for the day containing `now`.
 * Exported for test determinism — callers may pin "today" to a fixed
 * clock value. In production the middleware uses Date.now().
 */
export function utcMidnightIso(now: number = Date.now()): string {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(midnight).toISOString();
}

/**
 * Estimate a USD cost (in cents) from a token count when cost_cents
 * was zero on the llm_calls row. Used only as a fallback so the meter
 * never silently reports $0 for a model whose provider forgot to fill
 * the cost column. Returns 0 when the model has no pricing entry.
 */
export function estimateCostUsdCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICING_USD_PER_MTOK[model];
  if (!price) return 0;
  const promptUsd = (inputTokens / 1_000_000) * price.prompt;
  const completionUsd = (outputTokens / 1_000_000) * price.completion;
  return Math.round((promptUsd + completionUsd) * 100);
}

/**
 * Contract for the spend-meter the middleware consumes. Exported as an
 * interface so tests can inject a stub without touching SQLite. The
 * production implementation is `createBudgetMeter(db)`.
 */
export interface BudgetMeter {
  /**
   * Sum of autonomous LLM spend (in USD) for `workspaceId` since the
   * last UTC midnight. Never throws — on any DB error it logs via
   * pino and returns 0 (fail-open on observability, the middleware is
   * responsible for its own fail-open-on-enforcement behavior).
   */
  getCumulativeAutonomousSpendUsd(workspaceId: string, now?: number): Promise<number>;
}

interface LlmCallCostRow {
  cost_cents: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Production meter backed by the llm_calls telemetry table. Filters
 * rows by (workspace_id, origin='autonomous', created_at >= UTC-midnight)
 * and sums cost_cents, falling back to `estimateCostUsdCents` for rows
 * where the provider didn't populate cost_cents. Returns USD (float).
 *
 * The origin filter came in with migration 141. Existing rows backfill
 * as 'autonomous' via the column DEFAULT, so behavior is identical to
 * the pre-migration meter until callers start writing 'interactive'.
 */
export function createBudgetMeter(db: DatabaseAdapter): BudgetMeter {
  return {
    async getCumulativeAutonomousSpendUsd(workspaceId, now = Date.now()): Promise<number> {
      const since = utcMidnightIso(now);
      try {
        const { data } = await db
          .from<LlmCallCostRow>('llm_calls')
          .select('cost_cents, model, input_tokens, output_tokens')
          .eq('workspace_id', workspaceId)
          .eq('origin', 'autonomous')
          .gte('created_at', since);
        const rows = (data ?? []) as LlmCallCostRow[];
        let totalCents = 0;
        for (const r of rows) {
          const recorded = Number(r.cost_cents) || 0;
          if (recorded > 0) {
            totalCents += recorded;
            continue;
          }
          totalCents += estimateCostUsdCents(
            r.model,
            Number(r.input_tokens) || 0,
            Number(r.output_tokens) || 0,
          );
        }
        return totalCents / 100;
      } catch (err) {
        logger.warn(
          { err, workspaceId },
          'budget-meter: failed to read llm_calls; treating spend as 0',
        );
        return 0;
      }
    },
  };
}
