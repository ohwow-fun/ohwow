/**
 * ImprovementScheduler — Automated self-improvement cycle.
 *
 * Runs the improvement cycle (memory compression, pattern mining,
 * skill synthesis, principle distillation, etc.) on a timer.
 * Gates expensive LLM phases behind task volume thresholds:
 * only runs if >= MIN_NEW_TASKS tasks have completed since the last run.
 *
 * Lightweight phases (pattern mining, signal evaluation, digital twin)
 * always run. LLM-dependent phases (compression, synthesis, distillation)
 * require sufficient new task data to justify the cost.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ModelRouter } from '../execution/model-router.js';
import { runImprovementCycle } from '../lib/self-improvement/improve.js';
import { enforceMemoryCap, archiveOldExperiments } from '../lib/memory-maintenance.js';
import { logger } from '../lib/logger.js';

/** Minimum completed tasks since last run to justify LLM phases */
const MIN_NEW_TASKS_FOR_LLM = 10;

/** Default interval: 24 hours */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Settings key for tracking last improvement run */
const LAST_RUN_KEY = 'improvement_last_run_at';
const LAST_RUN_TASK_COUNT_KEY = 'improvement_last_task_count';

export class ImprovementScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executing = false;

  constructor(
    private db: DatabaseAdapter,
    private modelRouter: ModelRouter,
    private workspaceId: string,
    private intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Check if we should run immediately (e.g. missed overnight)
    const shouldRunNow = await this.shouldRunNow();
    if (shouldRunNow) {
      this.execute().catch(err => {
        logger.error({ err }, '[ImprovementScheduler] Initial run failed');
      });
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
   */
  async execute(): Promise<void> {
    if (this.executing) return;
    this.executing = true;

    try {
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
        { skipLLM },
      );

      // Persist run metadata
      const now = new Date().toISOString();
      await this.upsertSetting(LAST_RUN_KEY, now);
      await this.upsertSetting(LAST_RUN_TASK_COUNT_KEY, String(currentTaskCount));

      // Post-cycle: enforce memory cap and archive old experiments
      const memoriesDeactivated = await enforceMemoryCap(this.db, this.workspaceId);
      const archiveResult = await archiveOldExperiments(this.db, this.workspaceId);

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
          skipLLM,
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
