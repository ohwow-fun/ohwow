/**
 * Budget middleware — pre-dispatch gate for LLM calls. Gap 13 owns this.
 *
 * The threshold chain mirrors the gap file:
 *   <  70%  → pass through, emit nothing.
 *    70-85% → pass through, emit a one-shot budget.warn pulse.
 *    85-95% → demote Anthropic-default task classes to Gemini 3.1 Pro,
 *             except hardest_reasoning (correctness > cost on the
 *             hardest class). Emit a budget.degrade pulse.
 *    95-100% → pause non-revenue-critical autonomous calls by throwing
 *             BudgetPausedError. `bypass: 'revenue_critical'` escapes.
 *             Interactive always passes.
 *    >= 100% → hard halt for autonomous calls regardless of bypass
 *             flag; BudgetExceededError. Interactive still passes.
 *
 * Fail-safe rule: if the meter itself throws (e.g. DB melted), the
 * middleware MUST pass through and log. Enforcement is a nice-to-have;
 * a broken meter must not break production calls. The tests colocated
 * in __tests__/budget-middleware.test.ts enforce this invariant.
 */

import { logger } from '../lib/logger.js';
import type { BudgetMeter, CallOrigin } from './budget-meter.js';
import type { TaskClass, RouterDefault } from './router-defaults.js';
import { resolveRouterDefault } from './router-defaults.js';

/** Emitted once per workspace per day when spend crosses 70%. */
export interface BudgetWarnEvent {
  type: 'budget.warn';
  workspaceId: string;
  spentUsd: number;
  limitUsd: number;
  utilization: number;
}

/** Emitted once per workspace per day when spend crosses 85%. */
export interface BudgetDegradeEvent {
  type: 'budget.degrade';
  workspaceId: string;
  spentUsd: number;
  limitUsd: number;
  utilization: number;
  /** Which task class got demoted on this call. */
  taskClass: TaskClass;
  /** The original default the caller would have gotten. */
  originalModel: string;
  /** The cheaper model we substituted in. */
  substitutedModel: string;
}

/**
 * Emitted once per workspace per day when an autonomous call is PAUSED
 * in the 95-100% band (no revenue_critical bypass). Fires on the same
 * code path that throws BudgetPausedError so the operator sees the
 * pause in the dashboard, not just in pino logs.
 */
export interface BudgetPauseEvent {
  type: 'budget.pause';
  workspaceId: string;
  spentUsd: number;
  limitUsd: number;
  utilization: number;
}

/**
 * Emitted once per workspace per day when an autonomous call is HALTED
 * at 100%+ of the cap. Fires on the same code path that throws
 * BudgetExceededError. Revenue_critical bypass does NOT escape this
 * band, so the halt notice is the final operator signal of the day.
 */
export interface BudgetHaltEvent {
  type: 'budget.halt';
  workspaceId: string;
  spentUsd: number;
  limitUsd: number;
  utilization: number;
}

export type BudgetPulseEvent =
  | BudgetWarnEvent
  | BudgetDegradeEvent
  | BudgetPauseEvent
  | BudgetHaltEvent;

/**
 * Thrown when a workspace is between 95% and 100% of its cap and the
 * call is autonomous without a `bypass: 'revenue_critical'` flag.
 * Message text is user-facing (surfaces in operator logs + retry copy),
 * so it follows the project copywriting rules: direct, no em dashes,
 * no "Failed to".
 */
export class BudgetPausedError extends Error {
  readonly workspaceId: string;
  readonly spentUsd: number;
  readonly limitUsd: number;
  constructor(workspaceId: string, spentUsd: number, limitUsd: number) {
    super(
      `Autonomous LLM calls are paused for workspace ${workspaceId}. Today's spend $${spentUsd.toFixed(2)} is at or above 95% of the $${limitUsd.toFixed(2)} daily cap. Pass bypass "revenue_critical" to escape, or raise the cap.`,
    );
    this.name = 'BudgetPausedError';
    this.workspaceId = workspaceId;
    this.spentUsd = spentUsd;
    this.limitUsd = limitUsd;
  }
}

/**
 * Thrown when a workspace has hit or exceeded 100% of its daily cap.
 * Unlike BudgetPausedError, this one ignores the revenue_critical
 * bypass; the hard halt is the operator-override gate.
 */
export class BudgetExceededError extends Error {
  readonly workspaceId: string;
  readonly spentUsd: number;
  readonly limitUsd: number;
  constructor(workspaceId: string, spentUsd: number, limitUsd: number) {
    super(
      `Autonomous LLM calls are halted for workspace ${workspaceId}. Today's spend $${spentUsd.toFixed(2)} is at or above the $${limitUsd.toFixed(2)} daily cap. Raise the cap to resume.`,
    );
    this.name = 'BudgetExceededError';
    this.workspaceId = workspaceId;
    this.spentUsd = spentUsd;
    this.limitUsd = limitUsd;
  }
}

/** Model the middleware substitutes in at the 85-95% band. */
export const DEGRADE_FALLBACK: RouterDefault = {
  provider: 'google',
  model: 'gemini-3.1-pro',
  effort: 'medium',
};

/** Task classes eligible for demotion in the 85-95% band. */
const DEGRADABLE_CLASSES: ReadonlySet<TaskClass> = new Set<TaskClass>([
  'agentic_coding',
  'computer_use',
  'bulk_cost_sensitive',
]);

/**
 * Default daily cap when no workspace override is configured. $50 is a
 * deliberate stance: recorded burn is ~$34/day with zero revenue, so
 * $50 gives headroom for legit spikes while keeping a runaway loop
 * from turning into a $500 nightly surprise.
 */
export const DEFAULT_AUTONOMOUS_SPEND_LIMIT_USD = 50;

export interface BudgetMiddlewareInput {
  workspaceId: string;
  /** Per-workspace daily cap in USD. If undefined, DEFAULT_AUTONOMOUS_SPEND_LIMIT_USD applies. */
  limitUsd?: number;
  /** autonomous | interactive. Defaults to autonomous if caller leaves it unset. */
  origin?: CallOrigin;
  /** TaskClass the call is tagged with. Used to pick the default model and to gate demotion. */
  taskClass?: TaskClass;
  /** Opt-out for revenue-critical autonomous calls inside the 95-100% band. Ignored >= 100%. */
  bypass?: 'revenue_critical';
  /** Clock override for test determinism. Defaults to Date.now(). */
  now?: number;
}

export interface BudgetMiddlewareResult {
  /** The default the dispatcher should use. May be the original or a demoted fallback. */
  routerDefault: RouterDefault;
  /** One-shot pulse event the dispatcher should forward to the pulse bus. Undefined when nothing to emit. */
  pulseEvent?: BudgetPulseEvent;
  /** True when a demotion was applied. Caller may log this for telemetry. */
  demoted: boolean;
}

export interface BudgetMiddlewareDeps {
  meter: BudgetMeter;
  /**
   * Remembers which pulse events have already fired today per workspace
   * so warn/degrade emit exactly once per day. Injected so the daemon
   * can share one instance across all runLlmCall invocations and the
   * tests can start from a clean slate.
   */
  emittedToday: EmittedTodayTracker;
  /**
   * Optional pulse forwarder. The middleware builds the event; the
   * caller decides where to route it. Defaulted to a noop by the
   * dispatcher wiring when no bus is wired up (this round ships
   * without a pulse slot; see gap 13 Progress log).
   */
  emitPulse?: (event: BudgetPulseEvent) => void;
}

/**
 * Simple per-day, per-workspace once-set for pulse de-duplication.
 *
 * `kind` covers all four band transitions — warn (70%), degrade (85%),
 * pause (95%), halt (100%+). Each fires at most once per workspace per
 * UTC day, so a stuck autonomous loop cannot spam the operator with
 * duplicate toasts for the same transition.
 */
export type BudgetTransitionKind = 'warn' | 'degrade' | 'pause' | 'halt';
export interface EmittedTodayTracker {
  /** Returns true and records the emission; false if this key already fired today. */
  claim(workspaceId: string, kind: BudgetTransitionKind, now?: number): boolean;
}

/** Factory for the default in-memory tracker. Resets naturally as the day turns. */
export function createEmittedTodayTracker(): EmittedTodayTracker {
  const seen = new Map<string, string>();
  return {
    claim(workspaceId, kind, now = Date.now()) {
      const dayKey = new Date(now).toISOString().slice(0, 10);
      const k = `${workspaceId}::${kind}`;
      const existing = seen.get(k);
      if (existing === dayKey) return false;
      seen.set(k, dayKey);
      return true;
    },
  };
}

/**
 * Consult the meter and apply the gap-13 threshold chain. Returns the
 * routerDefault the dispatcher should actually use (possibly demoted)
 * and an optional pulse event. Throws BudgetPausedError /
 * BudgetExceededError in the 95-100% and >=100% bands respectively,
 * per the gap-file policy.
 *
 * Never fails open on an unexpected meter error. On throw, the
 * middleware logs via pino and returns the original default untouched.
 */
export async function applyBudgetMiddleware(
  deps: BudgetMiddlewareDeps,
  input: BudgetMiddlewareInput,
): Promise<BudgetMiddlewareResult> {
  const taskClass = input.taskClass;
  const originalDefault = taskClass ? resolveRouterDefault(taskClass) : undefined;
  const origin: CallOrigin = input.origin ?? 'autonomous';
  const limitUsd = input.limitUsd ?? DEFAULT_AUTONOMOUS_SPEND_LIMIT_USD;

  // Fallback default used when the dispatcher asked without a taskClass.
  // Degradation only meaningfully operates on a known class, but we still
  // return *something* in the result so the caller doesn't have to branch.
  const fallbackForUnknownClass: RouterDefault = originalDefault ?? DEGRADE_FALLBACK;

  let spentUsd = 0;
  try {
    spentUsd = await deps.meter.getCumulativeAutonomousSpendUsd(input.workspaceId, input.now);
  } catch (err) {
    // Fail-safe: the meter should not throw (createBudgetMeter already
    // catches), but a stubbed meter in a test or a future swap might.
    // Pass through with the unmodified default and log.
    logger.warn(
      { err, workspaceId: input.workspaceId },
      'budget-middleware: meter threw; passing call through untouched',
    );
    return { routerDefault: fallbackForUnknownClass, demoted: false };
  }

  const utilization = limitUsd > 0 ? spentUsd / limitUsd : 0;

  // Interactive calls: pass through at every band. This round counts
  // them in the meter but does not gate on them. Gating interactive is
  // out of scope; see gap 13 Progress log.
  if (origin === 'interactive') {
    return { routerDefault: fallbackForUnknownClass, demoted: false };
  }

  // >= 100%: hard halt. bypass flag does NOT escape this band. Fire a
  // one-shot budget.halt pulse so the operator surface (toast, email,
  // wherever the notifier routes) sees the halt, not just the stderr
  // pino log that comes from the error throw below.
  if (utilization >= 1.0) {
    const haltEvent: BudgetHaltEvent = {
      type: 'budget.halt',
      workspaceId: input.workspaceId,
      spentUsd,
      limitUsd,
      utilization,
    };
    if (deps.emittedToday.claim(input.workspaceId, 'halt', input.now)) {
      deps.emitPulse?.(haltEvent);
    }
    throw new BudgetExceededError(input.workspaceId, spentUsd, limitUsd);
  }

  // 95-100%: pause unless bypass='revenue_critical' is set. Fire a
  // one-shot budget.pause pulse before the throw so an operator who
  // did not wire bypass='revenue_critical' still sees the pause land
  // somewhere user-visible.
  if (utilization >= 0.95) {
    if (input.bypass !== 'revenue_critical') {
      const pauseEvent: BudgetPauseEvent = {
        type: 'budget.pause',
        workspaceId: input.workspaceId,
        spentUsd,
        limitUsd,
        utilization,
      };
      if (deps.emittedToday.claim(input.workspaceId, 'pause', input.now)) {
        deps.emitPulse?.(pauseEvent);
      }
      throw new BudgetPausedError(input.workspaceId, spentUsd, limitUsd);
    }
    // revenue-critical: pass through, but still demote if eligible.
    if (taskClass && DEGRADABLE_CLASSES.has(taskClass) && originalDefault) {
      return {
        routerDefault: DEGRADE_FALLBACK,
        demoted: true,
      };
    }
    return { routerDefault: fallbackForUnknownClass, demoted: false };
  }

  // 85-95%: demote eligible Anthropic defaults. Keep hardest_reasoning
  // on its original default — correctness beats cost in that band.
  if (utilization >= 0.85) {
    if (taskClass && DEGRADABLE_CLASSES.has(taskClass) && originalDefault) {
      const event: BudgetDegradeEvent = {
        type: 'budget.degrade',
        workspaceId: input.workspaceId,
        spentUsd,
        limitUsd,
        utilization,
        taskClass,
        originalModel: originalDefault.model,
        substitutedModel: DEGRADE_FALLBACK.model,
      };
      if (deps.emittedToday.claim(input.workspaceId, 'degrade', input.now)) {
        deps.emitPulse?.(event);
      }
      return { routerDefault: DEGRADE_FALLBACK, demoted: true, pulseEvent: event };
    }
    // hardest_reasoning / agentic_search / private_offline: no demotion.
    return { routerDefault: fallbackForUnknownClass, demoted: false };
  }

  // 70-85%: warn only. No demotion.
  if (utilization >= 0.70) {
    const event: BudgetWarnEvent = {
      type: 'budget.warn',
      workspaceId: input.workspaceId,
      spentUsd,
      limitUsd,
      utilization,
    };
    if (deps.emittedToday.claim(input.workspaceId, 'warn', input.now)) {
      deps.emitPulse?.(event);
    }
    return { routerDefault: fallbackForUnknownClass, demoted: false, pulseEvent: event };
  }

  // < 70%: clean pass-through.
  return { routerDefault: fallbackForUnknownClass, demoted: false };
}
