/**
 * Daemon hook for the Conductor (Phase 5).
 *
 * Wired in `src/daemon/start.ts` so the daemon spawns the Conductor loop
 * alongside ImprovementScheduler when (and only when)
 * `OHWOW_AUTONOMY_CONDUCTOR=1` is set. Default: off. Production behavior
 * does not change unless the flag flips (gated by Phase 6's evaluation
 * harness).
 *
 * ImprovementScheduler is NOT modified — the Conductor runs in parallel.
 */
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { EternalSpec } from '../eternal/types.js';
import { isValidWorkspaceName } from '../config.js';
import {
  CONDUCTOR_ENV_FLAG,
  defaultMakeStubExecutor,
  isConductorEnabled,
  startConductorLoop,
  type ConductorLoopHandle,
} from './conductor.js';
import { defaultDirectorIO } from './director.js';
import type { RoundExecutor } from './types.js';
import type { ModelRouter } from '../execution/model-router.js';
import {
  makeLlmPlanExecutor,
  makeQaJudgeExecutor,
  modelClientFromRouter,
  newLlmMeter,
  withSpendCap,
} from './executors/llm-executor.js';

/** Default tick: 1h (matches the spec's IMPROVEMENT_INTERVAL_MS default). */
export const DEFAULT_CONDUCTOR_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Model used for real-LLM plan rounds in production (dark-launch).
 * Kept as a named constant so bumping the model requires a single edit.
 */
export const DEFAULT_LLM_MODEL = 'anthropic/claude-haiku-4.5';

/**
 * Per-arc LLM spend cap in cents for the dark-launch conductor.
 * Set intentionally below all MODE_BUDGETS values so the budget-exceeded
 * check in director.ts is the outer guard; this cap is a safety floor.
 */
export const CONDUCTOR_ARC_SPEND_CAP_CENTS = 5;
/**
 * Feature flag: when true, wire the real LLM executor for all round kinds
 * (plan, impl, qa) instead of using the stub. Requires modelRouter to be
 * provided; if absent, the stub is used regardless.
 * 
 * Phase 6 production rollout gate.
 */
export const IS_REAL_EXECUTOR_ENABLED = process.env.OHWOW_REAL_EXECUTOR === 'true';


export interface WireConductorOptions {
  db: DatabaseAdapter;
  workspace_id: string;
  /**
   * Workspace slug (the on-disk directory name under
   * `~/.ohwow/workspaces/`). Distinct from `workspace_id`, which after
   * cloud consolidation is the canonical workspace UUID. The slug is
   * needed to resolve the per-arc file-mirror layout. When missing /
   * invalid, the file mirror is skipped (a `pino.warn` is logged and
   * the rest of the conductor still runs).
   */
  workspace_slug?: string;
  /** Defaults to DEFAULT_CONDUCTOR_INTERVAL_MS. */
  intervalMs?: number;
  /** Path to the runtime repo for SHA capture. */
  repoRoot?: string;
  /** Path to the cloud repo for SHA capture. */
  cloudRepoRoot?: string;
  /** Optional executor factory; defaults to the Phase-5 stub. */
  makeExecutor?: () => RoundExecutor;
  /**
   * When provided, plan rounds use the real LLM (Haiku) via this router
   * instead of the stub. A fresh `LlmMeter` is created per-arc; the arc
   * spend is capped at `CONDUCTOR_ARC_SPEND_CAP_CENTS` (5c) for the
   * dark-launch. If absent, falls back to `makeExecutor` or the stub.
   */
  modelRouter?: ModelRouter;
  /**
   * Operator-configured eternal spec. When absent, the conductor falls back
   * to DEFAULT_ETERNAL_SPEC for escalation rule evaluation.
   */
  eternalSpec?: EternalSpec;
}

/**
 * Returns null when the env flag is off (no loop started). Otherwise
 * returns a handle whose `stop()` clears the interval.
 */
export function wireConductor(
  opts: WireConductorOptions,
): ConductorLoopHandle | null {
  if (!isConductorEnabled()) {
    logger.info(
      `[daemon] Autonomy Conductor disabled (set ${CONDUCTOR_ENV_FLAG}=1 to enable)`,
    );
    return null;
  }
  let workspaceSlug: string | undefined;
  if (opts.workspace_slug && isValidWorkspaceName(opts.workspace_slug)) {
    workspaceSlug = opts.workspace_slug;
  } else if (opts.workspace_slug) {
    logger.warn(
      { workspace_slug: opts.workspace_slug },
      '[daemon] Autonomy file mirror disabled: invalid workspace slug',
    );
  } else {
    logger.warn(
      '[daemon] Autonomy file mirror disabled: no workspace slug supplied',
    );
  }
  // Forward-ref closure: the Director's `requestImmediateTick` hook
  // (called on arc close) must call back into the Conductor handle, but
  // the handle doesn't exist yet. Capture a mutable `trigger` ref and
  // assign it after `startConductorLoop` returns.
  let trigger: (() => void) | null = null;
  const io = defaultDirectorIO({
    db: opts.db,
    repoRoot: opts.repoRoot,
    cloudRepoRoot: opts.cloudRepoRoot,
    workspace_slug: workspaceSlug,
  });
  io.requestImmediateTick = () => {
    trigger?.();
  };
  // Build the per-arc executor factory. When a ModelRouter is available,
  // plan rounds call the real LLM (Haiku) via a fresh meter per arc.
  // A 5c/arc spend cap is enforced via withSpendCap so the dark-launch
  // can't accumulate unexpected cost. impl + qa still use the stub.
  //
  // The current meter is tracked in a shared mutable ref so `getArcMeter`
  // always returns the meter for the arc that `makeExecutor` last created.
  // Conductor runs one arc at a time (arc-in-flight guard), so the ref
  // is always coherent: makeExecutor() is called once per arc, before
  // runArc starts, and getArcMeter is read synchronously in the same tick.
  let currentMeter = newLlmMeter();
  const makeExecutor: () => RoundExecutor = opts.modelRouter
    ? () => {
        currentMeter = newLlmMeter();
        const baseClient = modelClientFromRouter(opts.modelRouter!, 'planning');
        const cappedClient = withSpendCap(
          baseClient,
          currentMeter,
          CONDUCTOR_ARC_SPEND_CAP_CENTS,
        );
        const stubFallback = defaultMakeStubExecutor();
        const planExecutor = makeLlmPlanExecutor({
          model: DEFAULT_LLM_MODEL,
          client: cappedClient,
          fallback: stubFallback,
          meter: currentMeter,
        });
        return makeQaJudgeExecutor({
          model: DEFAULT_LLM_MODEL,
          client: cappedClient,
          fallback: planExecutor,
          meter: currentMeter,
        });
      }
    : opts.makeExecutor ?? defaultMakeStubExecutor;

  const handle = startConductorLoop({
    db: opts.db,
    io,
    workspace_id: opts.workspace_id,
    makeExecutor,
    // Expose the current arc's meter so conductorTick can wire
    // getLlmCents into ArcInput for live cost accounting.
    getArcMeter: opts.modelRouter ? () => currentMeter : undefined,
    intervalMs: opts.intervalMs ?? DEFAULT_CONDUCTOR_INTERVAL_MS,
    eternalSpec: opts.eternalSpec,
  });
  trigger = handle.requestImmediateTick;
  logger.info(
    {
      workspace_id: opts.workspace_id,
      intervalMs: opts.intervalMs ?? DEFAULT_CONDUCTOR_INTERVAL_MS,
    },
    '[daemon] Autonomy Conductor started (dark-launch)',
  );
  return handle;
}
