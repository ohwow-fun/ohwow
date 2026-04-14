/**
 * Per-iteration model selection for agent tool loops.
 *
 * Picks from the AGENT_MODEL_TIERS table below based on iteration index,
 * task difficulty, whether earlier iterations produced parse errors,
 * whether an SOP procedure is in the prompt, and whether vision is
 * required. No per-agent pin is consulted — the router owns this
 * decision entirely and only the OpenRouter provider participates;
 * every other provider returns undefined so it can use its own default.
 *
 * Extracted from RuntimeEngine so the tier constants + the selection
 * logic live next to each other instead of being split across a
 * module-top const and a private method 2800 lines below.
 *
 * Self-healing demotion
 * ---------------------
 * `refreshDemotedAgentModels` reads rolling tool-call rate from
 * `llm_calls` and updates a module-level Set of demoted model strings.
 * `selectAgentModelForIteration` consults the set before returning a
 * tier target; if the would-be pick is demoted, it falls back to the
 * next tier up. The refresher is invoked on daemon start and on a
 * 10-minute interval. Threshold: a model needs ≥10 work-shaped
 * samples in the last 7 days and a tool-call rate below 40% to be
 * demoted. Those numbers are tuned for the diary-trigger failure
 * mode — qwen3.5-9b had 100% samples, 0% tool-call rate on work
 * tasks, which lights up both.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ModelProvider } from './model-router.js';
import type { DifficultyLevel } from './difficulty-scorer.js';
import { logger } from '../lib/logger.js';

/**
 * Model tiers for per-iteration selection (from CURATED_OPENROUTER_MODELS).
 * Prioritize cost-effective models with reliable tool calling.
 */
export const AGENT_MODEL_TIERS = {
  FREE: 'xiaomi/mimo-v2-flash',             // FREE, 262K ctx, tools
  FAST: 'qwen/qwen3.5-35b-a3b',             // $0.16/$1.30 per M, 262K ctx, tools+vision. MoE w/ ~3B active params. Reliably emits OpenAI-format tool_calls — the 9B sibling returns text <function=...> pseudo-calls instead, which the router parses as 0 tool calls and trips the hallucination gate on work-shaped tasks.
  BALANCED: 'deepseek/deepseek-v3.2',       // $0.26/$0.38 per M, 163K ctx, tools
  STRONG: 'google/gemini-3.1-pro-preview',  // $2/$12 per M, 1M ctx, tools+vision, reliable tool calling
  VISION: 'google/gemini-3.1-flash-lite-preview', // 1M ctx, vision+tools, cheap
} as const;

// ─── Self-healing demotion cache ─────────────────────────────────────

/** Minimum work-shaped samples in the window before a model is eligible to be demoted. */
const DEMOTION_MIN_SAMPLES = 10;
/** Rolling tool-call rate below which a model is demoted. 0.40 = "calls tools <40% of the time". */
const DEMOTION_RATE_THRESHOLD = 0.40;
/** How far back to look when computing the rolling rate. */
const DEMOTION_WINDOW_DAYS = 7;
/** How often the refresher runs once the daemon starts. */
export const DEMOTION_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

interface DemotionStats {
  model: string;
  samples: number;
  toolCallRate: number;
}

const demotedModels = new Set<string>();
let lastRefreshAt = 0;
let lastRefreshStats: DemotionStats[] = [];

/** Test hook — resets the demotion cache so unit tests start clean. */
export function _resetAgentModelDemotionCacheForTests(): void {
  demotedModels.clear();
  lastRefreshAt = 0;
  lastRefreshStats = [];
}

/** Operator-visible snapshot of the demotion state. */
export function getAgentModelDemotionSnapshot(): {
  demoted: string[];
  lastRefreshAt: number;
  stats: DemotionStats[];
} {
  return {
    demoted: Array.from(demotedModels),
    lastRefreshAt,
    stats: [...lastRefreshStats],
  };
}

/**
 * Recompute the demotion set from llm_calls. Called on daemon start and
 * every DEMOTION_REFRESH_INTERVAL_MS thereafter. Swallows errors — a
 * refresh failure must never break the selector, so on error the
 * existing set stays in place and the next refresh tries again.
 */
export async function refreshDemotedAgentModels(db: DatabaseAdapter): Promise<void> {
  try {
    const since = new Date(Date.now() - DEMOTION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await db
      .from<{ model: string; tool_call_count: number | null }>('llm_calls')
      .select('model, tool_call_count')
      .eq('task_shape', 'work')
      .gte('created_at', since);

    const rows = (data ?? []) as Array<{ model: string; tool_call_count: number | null }>;
    const perModel = new Map<string, { samples: number; toolCalls: number }>();
    for (const r of rows) {
      if (r.tool_call_count === null || r.tool_call_count === undefined) continue;
      const bucket = perModel.get(r.model) ?? { samples: 0, toolCalls: 0 };
      bucket.samples += 1;
      if (r.tool_call_count > 0) bucket.toolCalls += 1;
      perModel.set(r.model, bucket);
    }

    const stats: DemotionStats[] = [];
    const nextDemoted = new Set<string>();
    for (const [model, bucket] of perModel.entries()) {
      const rate = bucket.samples > 0 ? bucket.toolCalls / bucket.samples : 0;
      stats.push({ model, samples: bucket.samples, toolCallRate: rate });
      if (bucket.samples >= DEMOTION_MIN_SAMPLES && rate < DEMOTION_RATE_THRESHOLD) {
        nextDemoted.add(model);
      }
    }

    // Atomic swap: clear the set and repopulate in a single turn so a
    // concurrent selector call never sees a half-built state.
    demotedModels.clear();
    for (const m of nextDemoted) demotedModels.add(m);
    lastRefreshAt = Date.now();
    lastRefreshStats = stats;

    if (nextDemoted.size > 0) {
      logger.info(
        { demoted: Array.from(nextDemoted), sampleCount: rows.length },
        '[agent-tiers] refreshed demoted model set',
      );
    } else {
      logger.debug(
        { sampleCount: rows.length, modelsTracked: stats.length },
        '[agent-tiers] refreshed demotion cache (no demotions)',
      );
    }
  } catch (err) {
    logger.warn({ err }, '[agent-tiers] demotion refresh failed, keeping previous set');
  }
}

/**
 * Walk up the tier ladder one step if the target model is demoted.
 * FREE → FAST → BALANCED → STRONG. A demoted STRONG is left as-is
 * (nowhere to escalate to); it'll show up in getAgentModelDemotionSnapshot
 * so an operator can investigate.
 */
function escalateIfDemoted(target: string): string {
  if (!demotedModels.has(target)) return target;
  if (target === AGENT_MODEL_TIERS.FREE) return escalateIfDemoted(AGENT_MODEL_TIERS.FAST);
  if (target === AGENT_MODEL_TIERS.FAST) return escalateIfDemoted(AGENT_MODEL_TIERS.BALANCED);
  if (target === AGENT_MODEL_TIERS.BALANCED) return escalateIfDemoted(AGENT_MODEL_TIERS.STRONG);
  return target; // STRONG or VISION — leave in place
}

/**
 * Select the best model string for a given agent tool-loop iteration.
 * Returns undefined for non-OpenRouter providers — they use their own
 * provider-default model and never consult this table.
 */
export function selectAgentModelForIteration(
  iteration: number,
  difficulty: DifficultyLevel | undefined,
  hasErrors: boolean,
  hasSOP: boolean,
  needsVision: boolean,
  provider: ModelProvider,
): string | undefined {
  // For non-OpenRouter providers, let them use their own default.
  if (provider.name !== 'openrouter') return undefined;

  // Vision-required: use a vision-capable model.
  if (needsVision) return escalateIfDemoted(AGENT_MODEL_TIERS.VISION);

  // SOP-driven tasks: stay on STRONG for the entire procedure. The SOP
  // has multi-step tool sequences (request_desktop → focus → type →
  // screenshot) and the model needs to continue calling tools, not just
  // summarize.
  if (hasSOP) {
    if (iteration <= 6) return escalateIfDemoted(AGENT_MODEL_TIERS.STRONG);
    return escalateIfDemoted(AGENT_MODEL_TIERS.FAST); // tail iterations for cleanup
  }

  // Iteration 0: quality matters most for initial reasoning + tool planning.
  if (iteration === 0) {
    if (difficulty === 'complex') return escalateIfDemoted(AGENT_MODEL_TIERS.STRONG);
    if (difficulty === 'moderate') return escalateIfDemoted(AGENT_MODEL_TIERS.BALANCED);
    return escalateIfDemoted(AGENT_MODEL_TIERS.FAST);
  }

  // Error recovery: escalate to balanced.
  if (hasErrors) return escalateIfDemoted(AGENT_MODEL_TIERS.BALANCED);

  // Later iterations: cheap tool-result routing.
  if (iteration >= 3) return escalateIfDemoted(AGENT_MODEL_TIERS.FREE);
  return escalateIfDemoted(AGENT_MODEL_TIERS.FAST);
}
