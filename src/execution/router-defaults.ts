/**
 * Authoritative agentic-defaults source for the ohwow model router.
 * Opus 4.7 is deliberately OPT-IN ONLY per the 2026-04-17 founder cost
 * decision; no TaskClass here defaults to it. Callers opt in per-agent
 * or per-call by picking an entry from SELECTABLE_MODELS.
 *
 * Gap 13 hook: the per-call dollar guardrail lives in
 * `./budget-middleware.ts`. Dispatchers (notably `llm-organ.ts`) call
 * `applyBudgetMiddleware(...)` before handing the routing target to
 * ModelRouter so the daily cap can pass-through, demote, pause, or
 * halt the call. This file keeps the defaults table; the middleware
 * owns the threshold chain. The unit test in
 * __tests__/router-defaults.test.ts is the opt-in-only regression
 * guard; __tests__/budget-middleware.test.ts guards the thresholds.
 */

export { applyBudgetMiddleware } from './budget-middleware.js';

/**
 * Named classes of work the router needs to reason about. Each class
 * maps to a default (provider + model + effort) below, and each class
 * may register one or more opt-in alternatives in SELECTABLE_MODELS.
 *
 * Classes are deliberately coarse. The finer `Purpose` enum in
 * `execution-policy.ts` still drives per-call policy shape
 * (modelSource / fallback); TaskClass only answers "which concrete
 * model should this flavor of work prefer when no override is set?".
 */
export type TaskClass =
  | 'agentic_coding'
  | 'computer_use'
  | 'hardest_reasoning'
  | 'agentic_search'
  | 'bulk_cost_sensitive'
  | 'private_offline';

/**
 * Reasoning effort levels exposed to the router. `xhigh` is new here
 * and is the legal effort value for Opus 4.7 / any opt-in that supports
 * extended-thinking budgets beyond the stock `high`. Today only the
 * hardest_reasoning default and its Opus 4.7 opt-in use `xhigh`; other
 * task classes stay on `low`/`medium`/`high`. Exported so downstream
 * callers validate against one source of truth; there was no pre-
 * existing router-wide effort enum to extend, so this is canonical.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh';

/** Shape of a per-class default routing target. */
export interface RouterDefault {
  /** Provider slug as understood by ModelRouter (e.g. 'anthropic', 'openai', 'google', 'ollama'). */
  provider: string;
  /** Concrete model identifier the provider expects. */
  model: string;
  /** Reasoning-effort hint. Providers that ignore this field treat it as advisory. */
  effort: EffortLevel;
  /** Optional cap on generated tokens. Callers may override per-call. */
  maxTokens?: number;
}

/**
 * Per-task-class DEFAULT model. These are the cheap-enough-to-run-in-
 * the-loop choices. NONE of these defaults is `claude-opus-4-7` — that
 * is the founder override landing on 2026-04-17. The unit test in
 * `__tests__/router-defaults.test.ts` enforces that invariant so a
 * future edit flipping a default to Opus 4.7 fails loudly.
 */
export const ROUTER_DEFAULTS: Record<TaskClass, RouterDefault> = {
  // Agentic coding: Sonnet 4.6 is Anthropic's default agentic workhorse; reliable tool-calling + 1M context + materially cheaper than Opus 4.7.
  agentic_coding:      { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'high'   },

  // Computer-use: same trade-off as agentic_coding. Sonnet 4.6 holds its own on OSWorld-style tasks at a fraction of Opus 4.7's bill.
  computer_use:        { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'high'   },

  // Hardest single-shot reasoning: Sonnet 4.6 at xhigh effort is the cost-sane default. Opt in to Opus 4.7 when a run specifically needs the top of the curve.
  hardest_reasoning:   { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'xhigh'  },

  // Agentic search / browse: GPT-5.4 Pro leads BrowseComp by a wide margin and is cheaper per successful browse than Opus 4.7 once tokenizer inflation is counted.
  agentic_search:      { provider: 'openai',    model: 'gpt-5.4-pro',       effort: 'high'   },

  // Bulk cost-sensitive work: Gemini 3.1 Pro is the cheapest-per-token frontier model that still handles tool calls reliably in our traffic mix.
  bulk_cost_sensitive: { provider: 'google',    model: 'gemini-3.1-pro',    effort: 'medium' },

  // Private / offline path: run fully local via Ollama. `llama3.1` matches `config.ts` defaultConfig.ollamaModel; per-workspace pulls can override.
  private_offline:     { provider: 'ollama',    model: 'llama3.1',          effort: 'medium' },
};

/** One entry in the SELECTABLE_MODELS registry: an opt-in alternative a caller may pick for a task class. */
export interface SelectableModel {
  provider: string;
  model: string;
  effort: EffortLevel;
  /** One-liner explaining when an operator should reach for this model over the default. */
  note: string;
}

/**
 * Opt-in alternatives a caller may select per task class via per-agent
 * config or per-call `preferModel` override. Choosing any of these
 * routes the call away from the ROUTER_DEFAULTS row without changing
 * the default table — this is how an operator pays for Opus 4.7 only
 * on the specific runs that need it.
 *
 * Shape: Record<TaskClass, SelectableModel[]> so callers can read the
 * full menu for a given class in one lookup.
 */
export const SELECTABLE_MODELS: Record<TaskClass, SelectableModel[]> = {
  agentic_coding: [
    {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      effort: 'high',
      note: 'Opus 4.7 — strongest agentic coding benchmarks (SWE-bench Verified / Terminal-Bench 2.0), opt-in only due to cost.',
    },
  ],
  computer_use: [
    {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      effort: 'high',
      note: 'Opus 4.7 — highest OSWorld-Verified score, opt-in only due to cost.',
    },
  ],
  hardest_reasoning: [
    {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      effort: 'xhigh',
      note: 'Opus 4.7 at xhigh extended-thinking — frontier single-shot reasoning, opt-in only due to cost.',
    },
  ],
  agentic_search: [],
  bulk_cost_sensitive: [],
  private_offline: [],
};

/**
 * Resolve the default routing target for a task class. Use this wherever
 * a caller currently hardcodes a model string or picks by hand — it
 * returns a plain value so callers can still pass `preferModel`/`effort`
 * down into `ModelRouter.selectForPurpose`. Does NOT consult opt-in
 * overrides; that's the caller's job (they read their own agent config
 * or request body and call `isSelectableModel(taskClass, model)` to
 * validate).
 */
export function resolveRouterDefault(taskClass: TaskClass): RouterDefault {
  return ROUTER_DEFAULTS[taskClass];
}

/**
 * Is `model` a registered opt-in override for `taskClass`? Callers use
 * this to validate per-agent / per-call `preferModel` values against
 * the cost-aware allow-list before passing them to `selectForPurpose`.
 */
export function isSelectableModel(taskClass: TaskClass, model: string): boolean {
  return SELECTABLE_MODELS[taskClass].some((m) => m.model === model);
}

/** List opt-in model choices registered for a given task class. */
export function selectableModelsFor(taskClass: TaskClass): readonly SelectableModel[] {
  return SELECTABLE_MODELS[taskClass];
}
