/**
 * Real-LLM scenario runner (Phase 6.9).
 *
 * Sits alongside the deterministic harness under
 * `src/autonomy/eval/harness.ts`. LLM scenarios:
 *   - live under `src/autonomy/eval/scenarios-llm/`
 *   - run only when BOTH `OHWOW_AUTONOMY_EVAL_REAL=1` AND the CLI
 *     `--real` (or `--real-only`) flag are set;
 *   - do NOT diff against a byte-stable golden (model output varies);
 *   - run structural assertions against the transcript, a captured
 *     plan RoundReturn, the meter, and the persisted phase reports;
 *   - hard-stop per-scenario at `spendCapCents`.
 *
 * The production daemon never imports this module (the conductor wiring
 * stays on the stub until a future phase explicitly flips to real-LLM).
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultMakeStubExecutor } from '../conductor.js';
import {
  listPhaseReportsForArc,
  updatePhaseReport,
  type PhaseReportRecord,
} from '../director-persistence.js';
import {
  makeLlmPlanExecutor,
  modelClientFromRouter,
  newLlmMeter,
  SpendCapExceeded,
  withSpendCap,
  type LlmMeter,
  type PlanModelClient,
} from '../executors/llm-executor.js';
import type { RoundBrief, RoundExecutor, RoundReturn } from '../types.js';
import { ModelRouter } from '../../execution/model-router.js';
import { loadConfig } from '../../config.js';
import { runScenarioKeepOpen } from './harness.js';
import type {
  Scenario,
  ScenarioAssertionContext,
  ScenarioTranscript,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Extended assertion context available to LLM scenarios only. */
export interface LlmAssertionContext extends ScenarioAssertionContext {
  /** Final meter after all rounds. */
  meter: LlmMeter;
  /** Captured plan RoundReturn from the (only) plan round in the run. */
  captured_plan_return?: RoundReturn;
  /** Captured qa RoundReturn from the (only) qa round in the run. */
  captured_qa_return?: RoundReturn;
  /** Persisted phase reports for the arc that opened this run. */
  phase_reports: PhaseReportRecord[];
}

export type LlmScenarioAssertion = (
  t: ScenarioTranscript,
  ctx: LlmAssertionContext,
) => Promise<void>;

export interface LlmScenario
  extends Omit<Scenario, 'assertions' | 'makeExecutor'> {
  assertions: LlmScenarioAssertion[];
  /**
   * Optional custom executor factory. When provided, the runner calls this
   * instead of building the default plan-only executor. The factory receives
   * the effective model, a spend-capped client, the shared meter, and capture
   * refs so `withPlanCapture` / `withQaCapture` can be applied.
   */
  makeExecutor?: (params: {
    effectiveModel: string;
    cappedClient: PlanModelClient;
    meter: LlmMeter;
    planCapture: { plan_return?: RoundReturn };
    qaCapture: { qa_return?: RoundReturn };
  }) => RoundExecutor;
}

export interface LlmScenarioResult {
  name: string;
  status: 'pass' | 'fail';
  reason?: string;
  input_tokens: number;
  output_tokens: number;
  cents: number;
  /** Phases that ran; typically one. */
  phase_count: number;
}

export interface RunLlmScenariosOptions {
  /** Default 'claude-haiku-4-5-20251001' (matches router default). */
  model?: string;
  /** Per-scenario spend cap in cents. Default 10 (==$0.10). */
  spendCapCents?: number;
  /** Optional explicit client; if omitted, built from a real ModelRouter. */
  makeClient?: () => Promise<PlanModelClient>;
  /** If true, continue on failures instead of short-circuiting. Default true. */
  continueOnFail?: boolean;
}

export interface LlmSuiteResult {
  pass: string[];
  fail: Array<{ name: string; reason: string }>;
  scenarios: LlmScenarioResult[];
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LLM_SCENARIOS_DIR = join(__dirname, 'scenarios-llm');

export const DEFAULT_LLM_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_LLM_SPEND_CAP_CENTS = 10;

// ---------------------------------------------------------------------------
// Env flag
// ---------------------------------------------------------------------------

export function isRealLlmEvalEnabled(): boolean {
  return process.env.OHWOW_AUTONOMY_EVAL_REAL === '1';
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface DiscoveredLlmScenario {
  name: string;
  scenario: LlmScenario;
}

async function discoverLlmScenarios(): Promise<DiscoveredLlmScenario[]> {
  let files: string[];
  try {
    files = readdirSync(LLM_SCENARIOS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .sort();
  } catch {
    return [];
  }
  const out: DiscoveredLlmScenario[] = [];
  for (const f of files) {
    const mod = (await import(join(LLM_SCENARIOS_DIR, f))) as {
      default?: LlmScenario;
    };
    if (!mod.default) {
      throw new Error(`LLM scenario file ${f} has no default export`);
    }
    out.push({ name: mod.default.name, scenario: mod.default });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Real-client construction
// ---------------------------------------------------------------------------

interface BuiltDefaultClient {
  client: PlanModelClient;
  /** Model id the executor should pass through; provider-specific. */
  model: string;
}

async function buildDefaultClient(
  preferredModel: string,
): Promise<BuiltDefaultClient> {
  const cfg = loadConfig();
  const anthropicKey = cfg.anthropicApiKey;
  const openRouterKey = cfg.openRouterApiKey;

  if (anthropicKey) {
    const router = new ModelRouter({
      anthropicApiKey: anthropicKey,
      modelSource: 'cloud',
      cloudProvider: 'anthropic',
    });
    return {
      client: modelClientFromRouter(router, 'planning'),
      model: preferredModel,
    };
  }

  if (openRouterKey) {
    // Map the canonical Haiku id onto OpenRouter's slug convention. If
    // the caller passes a non-Haiku model, respect their choice and
    // hope the slug is already OpenRouter-shaped.
    const mapped =
      preferredModel === 'claude-haiku-4-5-20251001'
        ? 'anthropic/claude-haiku-4.5'
        : preferredModel;
    const router = new ModelRouter({
      openRouterApiKey: openRouterKey,
      openRouterModel: mapped,
      modelSource: 'cloud',
      cloudProvider: 'openrouter',
    });
    return {
      client: modelClientFromRouter(router, 'planning'),
      model: mapped,
    };
  }

  throw new Error(
    'OHWOW_AUTONOMY_EVAL_REAL=1 requires either an Anthropic API key (ANTHROPIC_API_KEY / anthropicApiKey) or an OpenRouter API key (openRouterApiKey) in your ohwow config. Set one or unset the env var.',
  );
}

// ---------------------------------------------------------------------------
// Helpers: capture the first plan return; enforce the spend cap.
// ---------------------------------------------------------------------------

export function withPlanCapture(
  inner: RoundExecutor,
  capture: { plan_return?: RoundReturn },
): RoundExecutor {
  return {
    async run(brief: RoundBrief): Promise<RoundReturn> {
      const ret = await inner.run(brief);
      if (brief.kind === 'plan' && !capture.plan_return) {
        capture.plan_return = ret;
      }
      return ret;
    },
  };
}

export function withQaCapture(
  inner: RoundExecutor,
  capture: { qa_return?: RoundReturn },
): RoundExecutor {
  return {
    async run(brief: RoundBrief): Promise<RoundReturn> {
      const ret = await inner.run(brief);
      if (brief.kind === 'qa' && !capture.qa_return) {
        capture.qa_return = ret;
      }
      return ret;
    },
  };
}

// ---------------------------------------------------------------------------
// Cost plumbing
// ---------------------------------------------------------------------------

async function plumbCostToPhaseReports(
  db: ScenarioAssertionContext['db'],
  workspace_id: string,
  meter: LlmMeter,
): Promise<{ arc_id: string | null; reports: PhaseReportRecord[] }> {
  const { data } = await db
    .from<{ id: string; status: string; opened_at: string }>('director_arcs')
    .select('id, status, opened_at')
    .eq('workspace_id', workspace_id)
    .order('opened_at', { ascending: false });
  const arc = (data ?? [])[0];
  if (!arc) return { arc_id: null, reports: [] };
  const reports = await listPhaseReportsForArc(db, arc.id);
  if (reports.length === 0) return { arc_id: arc.id, reports: [] };

  // Split evenly across phases; typically one phase per real-LLM
  // scenario (Phase 6.9 scope). Round up so non-zero spend is visible
  // even when sub-1c.
  const perPhase = reports.length > 0
    ? Math.max(1, Math.ceil(meter.cents / reports.length))
    : 0;
  for (const r of reports) {
    await updatePhaseReport(db, {
      id: r.id,
      status: r.status,
      trios_run: r.trios_run,
      runtime_sha_start: r.runtime_sha_start,
      runtime_sha_end: r.runtime_sha_end,
      cloud_sha_start: r.cloud_sha_start,
      cloud_sha_end: r.cloud_sha_end,
      delta_pulse_json: null,
      delta_ledger: r.delta_ledger,
      inbox_added: r.inbox_added,
      remaining_scope: r.remaining_scope,
      next_phase_recommendation: r.next_phase_recommendation,
      cost_trios: r.cost_trios,
      cost_minutes: r.cost_minutes,
      cost_llm_cents: perPhase,
      raw_report: r.raw_report,
      ended_at: r.ended_at ?? new Date().toISOString(),
    });
  }
  const updated = await listPhaseReportsForArc(db, arc.id);
  return { arc_id: arc.id, reports: updated };
}

// ---------------------------------------------------------------------------
// Run a single LLM scenario
// ---------------------------------------------------------------------------

export async function runLlmScenario(
  scenario: LlmScenario,
  opts: RunLlmScenariosOptions,
): Promise<LlmScenarioResult> {
  const model = opts.model ?? DEFAULT_LLM_MODEL;
  const cap = opts.spendCapCents ?? DEFAULT_LLM_SPEND_CAP_CENTS;

  const meter = newLlmMeter();
  const planCapture: { plan_return?: RoundReturn } = {};
  const qaCapture: { qa_return?: RoundReturn } = {};

  let baseClient: PlanModelClient;
  let effectiveModel = model;
  try {
    if (opts.makeClient) {
      baseClient = await opts.makeClient();
    } else {
      const built = await buildDefaultClient(model);
      baseClient = built.client;
      effectiveModel = built.model;
    }
  } catch (err) {
    return {
      name: scenario.name,
      status: 'fail',
      reason: `client setup failed: ${(err as Error).message}`,
      input_tokens: 0,
      output_tokens: 0,
      cents: 0,
      phase_count: 0,
    };
  }
  const cappedClient = withSpendCap(baseClient, meter, cap);

  // Re-shape the LlmScenario into the harness's Scenario shape. The
  // harness's assertion pipeline runs a SECOND pass with the stub
  // executor; LLM scenarios don't want that behavior, so we hand it an
  // empty assertions array and re-run the LLM-flavored assertions
  // ourselves after the DB is live.
  const asBase: Scenario = {
    name: scenario.name,
    describe: scenario.describe,
    initial_seed: scenario.initial_seed,
    steps: scenario.steps,
    assertions: [],
    makeExecutor: () => {
      if (scenario.makeExecutor) {
        return scenario.makeExecutor({
          effectiveModel,
          cappedClient,
          meter,
          planCapture,
          qaCapture,
        });
      }
      const fallback = defaultMakeStubExecutor();
      const llmExec = makeLlmPlanExecutor({
        model: effectiveModel,
        client: cappedClient,
        fallback,
        meter,
      });
      return withPlanCapture(llmExec, planCapture);
    },
  };

  // One real-LLM run; keep the DB live so we can plumb cost_llm_cents
  // and run the structural assertions against live rows.
  let held;
  try {
    held = await runScenarioKeepOpen(asBase, { silent: true });
  } catch (err) {
    if (err instanceof SpendCapExceeded) {
      return {
        name: scenario.name,
        status: 'fail',
        reason: `budget-cap (${err.cents.toFixed(4)}c > ${err.capCents}c)`,
        input_tokens: meter.input_tokens,
        output_tokens: meter.output_tokens,
        cents: meter.cents,
        phase_count: 0,
      };
    }
    return {
      name: scenario.name,
      status: 'fail',
      reason: `runScenario threw: ${(err as Error).message}`,
      input_tokens: meter.input_tokens,
      output_tokens: meter.output_tokens,
      cents: meter.cents,
      phase_count: 0,
    };
  }

  try {
    if (meter.cents > cap) {
      return {
        name: scenario.name,
        status: 'fail',
        reason: `budget-cap (${meter.cents.toFixed(4)}c > ${cap}c)`,
        input_tokens: meter.input_tokens,
        output_tokens: meter.output_tokens,
        cents: meter.cents,
        phase_count: 0,
      };
    }

    const { reports } = await plumbCostToPhaseReports(
      held.db,
      held.workspace_id,
      meter,
    );

    const ctx: LlmAssertionContext = {
      db: held.db,
      workspace_id: held.workspace_id,
      meter,
      captured_plan_return: planCapture.plan_return,
      captured_qa_return: qaCapture.qa_return,
      phase_reports: reports,
    };

    for (const fn of scenario.assertions) {
      await fn(held.transcript, ctx);
    }

    return {
      name: scenario.name,
      status: 'pass',
      input_tokens: meter.input_tokens,
      output_tokens: meter.output_tokens,
      cents: meter.cents,
      phase_count: reports.length,
    };
  } catch (err) {
    return {
      name: scenario.name,
      status: 'fail',
      reason: `assertion failed: ${(err as Error).message}`,
      input_tokens: meter.input_tokens,
      output_tokens: meter.output_tokens,
      cents: meter.cents,
      phase_count: 0,
    };
  } finally {
    held.close();
  }
}

// ---------------------------------------------------------------------------
// Run all discovered LLM scenarios
// ---------------------------------------------------------------------------

export async function runAllLlmScenarios(
  opts: RunLlmScenariosOptions = {},
): Promise<LlmSuiteResult> {
  const startedMs = Date.now();
  const discovered = await discoverLlmScenarios();
  const results: LlmScenarioResult[] = [];
  const pass: string[] = [];
  const fail: LlmSuiteResult['fail'] = [];

  for (const { scenario } of discovered) {
    const res = await runLlmScenario(scenario, opts);
    results.push(res);
    // eslint-disable-next-line no-console
    console.log(
      `[LLM] ${res.name.padEnd(40)}  in=${res.input_tokens} out=${res.output_tokens} cost=${(res.cents / 100).toFixed(4)}  ${res.status.toUpperCase()}${res.reason ? `  (${res.reason})` : ''}`,
    );
    if (res.status === 'pass') {
      pass.push(res.name);
    } else {
      fail.push({ name: res.name, reason: res.reason ?? 'unknown' });
      if (!(opts.continueOnFail ?? true)) break;
    }
  }

  return {
    pass,
    fail,
    scenarios: results,
    duration_ms: Date.now() - startedMs,
  };
}
