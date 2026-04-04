/**
 * LocalScheduler — Runs cron schedules locally without cloud dependency.
 *
 * Uses a hybrid approach: a precise setTimeout chain targeting the next due
 * schedule, plus a 5-minute heartbeat for resilience (sleep/wake recovery,
 * missed signals). This replaces the old 60-second polling loop.
 *
 * Call notify() after any schedule CRUD operation to immediately recalculate
 * the next fire time instead of waiting for the heartbeat.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type { LocalTriggerEvaluator } from '../triggers/local-trigger-evaluator.js';
import type { LocalTrigger } from '../webhooks/ghl-types.js';
import { logger } from '../lib/logger.js';

interface ScheduleRow {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  workflow_id: string | null;
  label: string | null;
  cron: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  task_prompt: string | null;
}

/** Cached cron-parser module reference */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cronParserModule: any = null;

async function getCronParser(): Promise<typeof import('cron-parser')> {
  if (!cronParserModule) {
    cronParserModule = await import('cron-parser');
  }
  return cronParserModule;
}

const HEARTBEAT_INTERVAL = 300_000; // 5 minutes

export class LocalScheduler {
  private nextFireTimeout: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private triggerEvaluator: LocalTriggerEvaluator | null = null;
  /** Homeostasis controller for metabolic gating of schedule execution. */
  private homeostasis: { check(): { correctiveActions: Array<{ type: string; urgency: number }> } } | null = null;

  get isRunning(): boolean {
    return this.running;
  }
  private recalculating = false;

  constructor(
    private db: DatabaseAdapter,
    private engine: RuntimeEngine,
    private workspaceId: string,
  ) {}

  /**
   * Set the trigger evaluator for schedule-triggered automations.
   * Must be called before start() to enable automation schedule support.
   */
  setTriggerEvaluator(evaluator: LocalTriggerEvaluator): void {
    this.triggerEvaluator = evaluator;
  }

  /** Wire homeostasis controller for metabolic gating. */
  setHomeostasis(controller: { check(): { correctiveActions: Array<{ type: string; urgency: number }> } }): void {
    this.homeostasis = controller;
  }

  /**
   * Start the scheduler. Fires past-due schedules on startup,
   * then uses precise timeouts + a 5-minute heartbeat.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Pre-cache cron-parser
    await getCronParser();

    // Fire any past-due schedules on startup, then set the next timeout
    await this.tick();

    // Heartbeat: catch missed schedules from sleep/wake or timer drift
    this.heartbeatTimer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error('[LocalScheduler] Heartbeat error:', err);
      });
    }, HEARTBEAT_INTERVAL);
  }

  /** Stop the scheduler */
  stop(): void {
    this.running = false;
    if (this.nextFireTimeout) {
      clearTimeout(this.nextFireTimeout);
      this.nextFireTimeout = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Notify the scheduler that schedules have changed (CRUD).
   * Triggers an immediate recalculation of the next fire time.
   */
  notify(): void {
    if (!this.running) return;
    this.recalculate().catch((err) => {
      logger.error('[LocalScheduler] Recalculate error:', err);
    });
  }

  /**
   * Fire all past-due schedules, then recalculate the next timeout.
   */
  private async tick(): Promise<void> {
    const now = new Date().toISOString();

    // 1. Agent/workflow schedules (from agent_workforce_schedules)
    const { data } = await this.db
      .from<ScheduleRow>('agent_workforce_schedules')
      .select('*')
      .eq('workspace_id', this.workspaceId)
      .eq('enabled', 1);

    // Homeostasis gate: defer all schedule execution when system is throttling
    if (this.homeostasis) {
      try {
        const state = this.homeostasis.check();
        const throttle = state.correctiveActions.find(a => a.type === 'throttle');
        if (throttle && throttle.urgency > 0.7) {
          logger.info({ urgency: throttle.urgency }, 'scheduler: deferring all schedules due to homeostasis throttle');
          await this.recalculate();
          return;
        }
      } catch { /* homeostasis check is non-fatal */ }
    }

    if (data) {
      const schedules = data ?? [];
      for (const schedule of schedules) {
        if (!schedule.next_run_at) continue;
        if (schedule.next_run_at > now) continue;
        await this.fireSchedule(schedule);
      }
    }

    // 2. Automation schedule triggers (from local_triggers with trigger_type='schedule')
    if (this.triggerEvaluator) {
      await this.tickAutomationSchedules(now);
    }

    // After firing, recalculate the next timeout
    await this.recalculate();
  }

  /**
   * Recalculate and set a precise setTimeout for the next due schedule.
   * Queries both schedule sources, finds the earliest next_run_at, and
   * sets a timeout for exactly that moment.
   */
  private async recalculate(): Promise<void> {
    if (!this.running) return;
    // Prevent concurrent recalculations
    if (this.recalculating) return;
    this.recalculating = true;

    try {
      // Clear any existing timeout
      if (this.nextFireTimeout) {
        clearTimeout(this.nextFireTimeout);
        this.nextFireTimeout = null;
      }

      let earliestMs = Infinity;
      const now = Date.now();

      // 1. Check agent_workforce_schedules
      const { data: schedules } = await this.db
        .from<{ next_run_at: string | null }>('agent_workforce_schedules')
        .select('next_run_at')
        .eq('workspace_id', this.workspaceId)
        .eq('enabled', 1);

      if (schedules) {
        for (const row of schedules ?? []) {
          if (!row.next_run_at) continue;
          const ms = new Date(row.next_run_at).getTime();
          if (ms < earliestMs) earliestMs = ms;
        }
      }

      // 2. Check automation schedule triggers
      if (this.triggerEvaluator) {
        const { data: triggers } = await this.db
          .from<LocalTrigger>('local_triggers')
          .select('trigger_config, last_fired_at')
          .eq('trigger_type', 'schedule')
          .eq('enabled', 1);

        if (triggers) {
          for (const row of triggers ?? []) {
            try {
              const config = typeof row.trigger_config === 'string'
                ? JSON.parse(row.trigger_config) as Record<string, unknown>
                : {};
              const cron = config.cron as string;
              if (!cron) continue;
              const nextRun = await this.computeNextRunFrom(cron, row.last_fired_at);
              if (!nextRun) continue;
              const ms = new Date(nextRun).getTime();
              if (ms < earliestMs) earliestMs = ms;
            } catch {
              // Skip invalid triggers
            }
          }
        }
      }

      // If no schedules, no timeout needed (heartbeat will catch new ones)
      if (earliestMs === Infinity) return;

      const delayMs = Math.max(0, earliestMs - now);

      // If already past due, fire immediately
      if (delayMs === 0) {
        // Use setImmediate-like behavior to avoid recursive stack
        this.nextFireTimeout = setTimeout(() => {
          this.tick().catch((err) => {
            logger.error('[LocalScheduler] Tick error:', err);
          });
        }, 0);
        return;
      }

      // Set precise timeout for the next due schedule
      // Cap at heartbeat interval as a safety net (heartbeat will handle anything beyond)
      const cappedDelay = Math.min(delayMs, HEARTBEAT_INTERVAL);
      this.nextFireTimeout = setTimeout(() => {
        this.tick().catch((err) => {
          logger.error('[LocalScheduler] Tick error:', err);
        });
      }, cappedDelay);
    } finally {
      this.recalculating = false;
    }
  }

  /**
   * Check local_triggers with trigger_type='schedule' and fire any past due.
   */
  private async tickAutomationSchedules(now: string): Promise<void> {
    try {
      const { data: triggers } = await this.db
        .from<LocalTrigger>('local_triggers')
        .select('*')
        .eq('trigger_type', 'schedule')
        .eq('enabled', 1);

      if (!triggers) return;

      for (const row of triggers ?? []) {
        try {
          const config = typeof row.trigger_config === 'string'
            ? JSON.parse(row.trigger_config) as Record<string, unknown>
            : {};
          const cron = config.cron as string;
          if (!cron) continue;

          // Compute next run from cron + last_fired_at
          const nextRun = await this.computeNextRunFrom(cron, row.last_fired_at);
          if (!nextRun || nextRun > now) continue;

          // Fire the automation via trigger evaluator
          logger.info(`[LocalScheduler] Firing scheduled automation: ${row.name} (${cron})`);
          this.triggerEvaluator!.executeById(row.id).catch((err) => {
            logger.error(`[LocalScheduler] Automation schedule ${row.id} error: ${err}`);
          });
        } catch (err) {
          logger.error(`[LocalScheduler] Error evaluating automation schedule ${row.id}: ${err}`);
        }
      }
    } catch (err) {
      logger.error(`[LocalScheduler] Automation schedule tick error: ${err}`);
    }
  }

  /**
   * Compute next run time from cron + last_fired_at reference.
   * If never fired, returns the previous occurrence (fire immediately).
   */
  private async computeNextRunFrom(cron: string, lastFiredAt: string | null): Promise<string | null> {
    try {
      const { CronExpressionParser } = await getCronParser();
      if (lastFiredAt) {
        const interval = CronExpressionParser.parse(cron, { currentDate: new Date(lastFiredAt) });
        return interval.next().toISOString();
      }
      // Never fired: check if the previous occurrence is in the past
      const interval = CronExpressionParser.parse(cron);
      return interval.prev().toISOString();
    } catch {
      return null;
    }
  }

  /**
   * Fire a single schedule: create a task, execute it, and update next_run_at.
   */
  private async fireSchedule(schedule: ScheduleRow): Promise<void> {
    try {
      if (schedule.agent_id && schedule.task_prompt) {
        // Agent-based schedule
        const { data: taskData } = await this.db
          .from('agent_workforce_tasks')
          .insert({
            workspace_id: this.workspaceId,
            agent_id: schedule.agent_id,
            title: schedule.label || schedule.task_prompt.slice(0, 100),
            input: schedule.task_prompt,
            status: 'pending',
            priority: 'normal',
          })
          .select('id')
          .single();

        if (taskData) {
          const taskId = (taskData as { id: string }).id;
          // Execute async
          this.engine.executeTask(schedule.agent_id, taskId).catch((err) => {
            logger.error(`[LocalScheduler] Task execution failed for schedule ${schedule.id}:`, err);
          });
        }
      }

      // Update last_run_at and compute next_run_at
      const nextRun = await this.computeNextRun(schedule.cron);
      await this.db.from('agent_workforce_schedules').update({
        last_run_at: new Date().toISOString(),
        next_run_at: nextRun,
        updated_at: new Date().toISOString(),
      }).eq('id', schedule.id);

      // Log activity
      await this.db.rpc('create_agent_activity', {
        p_workspace_id: this.workspaceId,
        p_activity_type: 'schedule_fired',
        p_title: `Schedule fired: ${schedule.label || schedule.cron}`,
        p_description: schedule.task_prompt?.slice(0, 200) || '',
        p_agent_id: schedule.agent_id,
        p_task_id: null,
        p_metadata: { scheduleId: schedule.id, cron: schedule.cron },
      });
    } catch (err) {
      logger.error(`[LocalScheduler] Error firing schedule ${schedule.id}: ${err}`);
    }
  }

  /**
   * Compute the next run time from a cron expression.
   */
  private async computeNextRun(cron: string): Promise<string | null> {
    try {
      const { CronExpressionParser } = await getCronParser();
      const interval = CronExpressionParser.parse(cron);
      return interval.next().toISOString();
    } catch {
      return null;
    }
  }
}
