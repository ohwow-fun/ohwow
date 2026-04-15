/**
 * ImprovementScheduler — Automated self-improvement cycle with sleep integration.
 *
 * Runs the improvement cycle (memory compression, pattern mining,
 * skill synthesis, principle distillation, etc.) on a timer.
 * Gates expensive LLM phases behind task volume thresholds:
 * only runs if >= MIN_NEW_TASKS tasks have completed since the last run.
 *
 * When a SleepCycle is wired in, the scheduler uses sleep phases to determine
 * what to run: consolidation during deep_sleep, creative recombination during REM.
 * Without a SleepCycle, the existing flat-interval behavior is preserved.
 *
 * Lightweight phases (pattern mining, signal evaluation, digital twin)
 * always run. LLM-dependent phases (compression, synthesis, distillation)
 * require sufficient new task data to justify the cost.
 */

import type { EventEmitter } from 'node:events';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ModelRouter } from '../execution/model-router.js';
import type { HomeostasisController } from '../homeostasis/homeostasis-controller.js';
import { runImprovementCycle } from '../lib/self-improvement/improve.js';
import { enforceMemoryCap, archiveOldExperiments } from '../lib/memory-maintenance.js';
import { decaySynapses, computeSynapseHealth } from '../symbiosis/synapse-dynamics.js';
import { logger } from '../lib/logger.js';
import type { SleepCycle } from '../oneiros/sleep-cycle.js';

/** Minimum completed tasks since last run to justify LLM phases */
const MIN_NEW_TASKS_FOR_LLM = 10;

/** Default interval: 24 hours */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Settings key for tracking last improvement run */
const LAST_RUN_KEY = 'improvement_last_run_at';
const LAST_RUN_TASK_COUNT_KEY = 'improvement_last_task_count';
/**
 * Consolidation fallback window. If no deep_sleep pass fires within
 * this interval (which is the normal case on busy workspaces that
 * never idle), the scheduler forces one. 12h so the hippocampus
 * runs at least twice a day even if the system stays awake.
 */
const CONSOLIDATION_FORCE_MS = 12 * 60 * 60 * 1000;

export class ImprovementScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executing = false;
  private sleepCycle: SleepCycle | null = null;
  private homeostasis: HomeostasisController | null = null;
  private synthesisBus: EventEmitter | null = null;
  private lastIdleCheck = Date.now();
  /**
   * Hippocampus reflection hook. When set and SleepCycle reports
   * `shouldConsolidate()` on a tick, the scheduler invokes this
   * callback once per deep_sleep entry, then marks consolidation on
   * the sleep cycle so it doesn't fire again until the next cycle.
   */
  private reflectionConsolidator: (() => Promise<void>) | null = null;
  /**
   * Fallback for workspaces that never idle long enough to enter
   * deep_sleep. When the last consolidation was more than
   * CONSOLIDATION_FORCE_MS ago we run the hippocampus pass regardless
   * of sleep phase. Without this, busy workspaces (>1 task/min) stay
   * in `wake` forever and affective_memories never accumulates
   * reflection rows — observed in the live daemon after landing W1.
   */
  private lastForcedConsolidationAt = 0;

  constructor(
    private db: DatabaseAdapter,
    private modelRouter: ModelRouter,
    private workspaceId: string,
    private intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  /**
   * Wire the synthesis event bus (phase C of the unified-skill plan).
   *
   * When set, mined tool-call patterns found during the pattern-mining
   * phase of the improvement cycle are emitted on this bus as
   * `synthesis:candidate` events with `kind: 'pattern'`. The
   * `SynthesisAutoLearner` listening on the same bus picks them up and
   * persists them as code-skill rows. Without this wire the patterns
   * are mined but discarded — that was the phase-C gap before this
   * commit. Safe to call before `start()`.
   */
  setSynthesisBus(bus: EventEmitter): void {
    this.synthesisBus = bus;
    logger.info('[ImprovementScheduler] synthesis bus wired — mined patterns will flow to autolearner');
  }

  /**
   * Wire a SleepCycle for phase-aware improvement scheduling.
   * When wired, the scheduler uses sleep phases to determine operations:
   * - deep_sleep: memory consolidation + compression
   * - REM: creative recombination (dream associations)
   * Without a SleepCycle, the flat-interval behavior is preserved.
   */
  setSleepCycle(cycle: SleepCycle): void {
    this.sleepCycle = cycle;
    logger.info('[ImprovementScheduler] Sleep cycle wired — using phase-aware scheduling');
  }

  /** Get the sleep cycle instance (for external access). */
  getSleepCycle(): SleepCycle | null {
    return this.sleepCycle;
  }

  /**
   * Wire the reflection consolidator so it fires during deep_sleep.
   * The daemon builds the adapter that closes over db / dataDir / bus
   * / llm; the scheduler just invokes it once per consolidation phase.
   */
  setReflectionConsolidator(fn: () => Promise<void>): void {
    this.reflectionConsolidator = fn;
    logger.info('[ImprovementScheduler] reflection consolidator wired');
  }

  /** Wire a HomeostasisController for synapse health metric updates. */
  setHomeostasis(controller: HomeostasisController): void {
    this.homeostasis = controller;
  }

  /**
   * Run the reflection consolidator if more than CONSOLIDATION_FORCE_MS
   * has elapsed since the last one. Safe to call from multiple sites
   * (start(), execute()). Swallows errors so a failing consolidator
   * never breaks the caller.
   */
  private async runForcedConsolidationIfDue(): Promise<void> {
    if (!this.reflectionConsolidator) return;
    if (Date.now() - this.lastForcedConsolidationAt <= CONSOLIDATION_FORCE_MS) return;
    try {
      await this.reflectionConsolidator();
      this.lastForcedConsolidationAt = Date.now();
      logger.info('[ImprovementScheduler] forced reflection consolidation (no deep_sleep in window)');
    } catch (err) {
      logger.warn({ err }, '[ImprovementScheduler] forced reflection consolidation failed');
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Check if we should run immediately (e.g. missed overnight)
    const shouldRunNow = await this.shouldRunNow();
    if (shouldRunNow) {
      this.execute().catch(err => {
        logger.error({ err }, '[ImprovementScheduler] Initial run failed');
      });
    } else if (this.reflectionConsolidator) {
      // Even if the full improvement cycle isn't due, run a
      // consolidation on boot so the hippocampus has fresh memories
      // available to downstream experiments on every daemon restart.
      // Caps re-fire via lastForcedConsolidationAt + 12h window.
      this.runForcedConsolidationIfDue();
    }

    this.timer = setInterval(() => {
      this.execute().catch(err => {
        logger.error({ err }, '[ImprovementScheduler] Scheduled run failed');
      });
    }, this.intervalMs);

    logger.info(
      { intervalHours: Math.round(this.intervalMs / 3_600_000) },
      '[ImprovementScheduler] Started',
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Execute an improvement cycle if conditions are met.
   * Guards against concurrent execution.
   *
   * When a SleepCycle is wired, ticks the sleep state machine and runs
   * phase-appropriate operations (consolidation during deep_sleep, etc.).
   */
  async execute(): Promise<void> {
    if (this.executing) return;
    this.executing = true;

    try {
      // Tick the sleep cycle if wired
      if (this.sleepCycle) {
        const now = Date.now();
        const idleMs = now - this.lastIdleCheck;
        this.lastIdleCheck = now;
        this.sleepCycle.tick(idleMs);

        const sleepState = this.sleepCycle.getState();
        logger.debug(
          { phase: sleepState.phase, sleepDebt: sleepState.sleepDebt.toFixed(2) },
          '[ImprovementScheduler] Sleep phase tick',
        );

        // Hippocampus pass: during deep_sleep run the reflection
        // consolidator once per cycle. SleepCycle.markConsolidation
        // bumps the timestamp so we don't re-fire on every tick.
        if (this.sleepCycle.shouldConsolidate() && this.reflectionConsolidator) {
          try {
            await this.reflectionConsolidator();
          } catch (err) {
            logger.warn({ err }, '[ImprovementScheduler] reflection consolidator failed');
          }
          this.sleepCycle.markConsolidation();
          this.lastForcedConsolidationAt = now;
        }

        // During sleep, skip the normal improvement cycle — sleep handles it
        if (this.sleepCycle.isAsleep()) {
          logger.debug(
            { phase: sleepState.phase },
            '[ImprovementScheduler] Agent is asleep, skipping standard cycle',
          );
          return;
        }
      }

      // Forced consolidation fallback: on busy workspaces the sleep
      // cycle never reaches deep_sleep, so the hippocampus pass above
      // never fires. Without this fallback, affective_memories stays
      // empty and the reflection→patch-author seeding bridge is dead.
      await this.runForcedConsolidationIfDue();

      const currentTaskCount = await this.getCompletedTaskCount();
      const lastTaskCount = await this.getLastTaskCount();
      const newTasks = currentTaskCount - lastTaskCount;

      const skipLLM = newTasks < MIN_NEW_TASKS_FOR_LLM;

      if (skipLLM) {
        logger.info(
          { newTasks, threshold: MIN_NEW_TASKS_FOR_LLM },
          '[ImprovementScheduler] Below task threshold, running lightweight phases only',
        );
      } else {
        logger.info(
          { newTasks },
          '[ImprovementScheduler] Sufficient new tasks, running full cycle',
        );
      }

      const result = await runImprovementCycle(
        this.db,
        this.modelRouter,
        this.workspaceId,
        {
          skipLLM,
          // Phase C: mined patterns flow to the autolearner via this
          // bus when wired. Null is fine — skill-synthesizer treats a
          // missing bus as a no-op and drops patterns silently.
          synthesisBus: this.synthesisBus ?? undefined,
        },
      );

      // Persist run metadata
      const now = new Date().toISOString();
      await this.upsertSetting(LAST_RUN_KEY, now);
      await this.upsertSetting(LAST_RUN_TASK_COUNT_KEY, String(currentTaskCount));

      // Post-cycle: enforce memory cap and archive old experiments
      const memoriesDeactivated = await enforceMemoryCap(this.db, this.workspaceId);
      const archiveResult = await archiveOldExperiments(this.db, this.workspaceId);

      // Synapse maintenance: decay inactive connections and compute org health
      const decayResult = await decaySynapses(this.db, this.workspaceId);
      const synapseHealth = await computeSynapseHealth(this.db, this.workspaceId);
      if (this.homeostasis) {
        this.homeostasis.updateMetric('synapse_health', synapseHealth);
      }

      logger.info(
        {
          durationMs: result.durationMs,
          totalCostCents: result.totalCostCents,
          principles: result.principleDistillation?.principlesCreated ?? 0,
          skills: result.skillSynthesis?.skillsCreated ?? 0,
          patterns: result.patternMining?.patternsFound ?? 0,
          memoriesDeactivated,
          principlesArchived: archiveResult.principlesArchived,
          skillsArchived: archiveResult.skillsArchived,
          synapsesDecayed: decayResult.decayed,
          synapsesRemoved: decayResult.removed,
          synapseHealth: synapseHealth.toFixed(2),
          skipLLM,
          sleepPhase: this.sleepCycle?.getState().phase ?? 'n/a',
        },
        '[ImprovementScheduler] Cycle completed',
      );
    } catch (err) {
      logger.error({ err }, '[ImprovementScheduler] Cycle failed');
    } finally {
      this.executing = false;
    }
  }

  /**
   * Notify the scheduler that the agent received a new task.
   * Wakes the sleep cycle if the agent is asleep.
   */
  notifyActivity(): void {
    this.lastIdleCheck = Date.now();
    if (this.sleepCycle?.isAsleep()) {
      this.sleepCycle.wake('new_task_received');
      logger.info('[ImprovementScheduler] Agent woken by new activity');
    }
  }

  /**
   * Check if enough time has passed since the last run to justify
   * running immediately on startup (e.g. daemon was down overnight).
   */
  private async shouldRunNow(): Promise<boolean> {
    try {
      const { data } = await this.db.from('runtime_settings')
        .select('value').eq('key', LAST_RUN_KEY).maybeSingle();
      if (!data) return true; // Never run before
      const lastRun = new Date((data as Record<string, unknown>).value as string).getTime();
      return Date.now() - lastRun >= this.intervalMs;
    } catch {
      return true; // On error, run to be safe
    }
  }

  private async getCompletedTaskCount(): Promise<number> {
    try {
      const { count } = await this.db.from('agent_workforce_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', this.workspaceId)
        .in('status', ['completed', 'approved']);
      return count ?? 0;
    } catch {
      return 0;
    }
  }

  private async getLastTaskCount(): Promise<number> {
    try {
      const { data } = await this.db.from('runtime_settings')
        .select('value').eq('key', LAST_RUN_TASK_COUNT_KEY).maybeSingle();
      if (!data) return 0;
      return parseInt((data as Record<string, unknown>).value as string, 10) || 0;
    } catch {
      return 0;
    }
  }

  private async upsertSetting(key: string, value: string): Promise<void> {
    try {
      const { data } = await this.db.from('runtime_settings')
        .select('key').eq('key', key).maybeSingle();
      if (data) {
        await this.db.from('runtime_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key);
      } else {
        await this.db.from('runtime_settings').insert({ key, value, updated_at: new Date().toISOString() });
      }
    } catch (err) {
      logger.debug({ err, key }, '[ImprovementScheduler] Failed to persist setting');
    }
  }
}
