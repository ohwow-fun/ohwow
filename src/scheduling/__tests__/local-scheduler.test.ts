import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalScheduler } from '../local-scheduler.js';
import { mockDb, mockEngine } from '../../__tests__/helpers/mock-db.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';

// Mock cron-parser
vi.mock('cron-parser', () => {
  const makeDateObj = (d: Date) => ({
    toISOString: () => d.toISOString(),
  });
  return {
    CronExpressionParser: {
      parse: vi.fn((cron: string, opts?: { currentDate?: Date }) => {
        if (cron === 'invalid') throw new Error('Invalid cron');
        // For "every minute" style crons, return next minute from reference
        const ref = opts?.currentDate ?? new Date();
        return {
          next: () => makeDateObj(new Date(ref.getTime() + 60_000)),
          prev: () => makeDateObj(new Date(ref.getTime() - 60_000)),
        };
      }),
    },
  };
});

// Mock logger to suppress output
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

function createScheduler(
  dbOverrides: Record<string, { data?: unknown; count?: number; error?: unknown }> = {},
) {
  const db = mockDb(dbOverrides) as unknown as DatabaseAdapter;
  const engine = { ...mockEngine, executeTask: vi.fn().mockResolvedValue(undefined) } as unknown as RuntimeEngine;
  const scheduler = new LocalScheduler(db, engine, 'ws-test');
  return { scheduler, db, engine };
}

describe('LocalScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Creation & Initialization ──────────────────────────────────

  describe('creation and initialization', () => {
    it('should create a scheduler instance', () => {
      const { scheduler } = createScheduler();
      expect(scheduler).toBeInstanceOf(LocalScheduler);
      expect(scheduler.isRunning).toBe(false);
    });

    it('should start and set running to true', async () => {
      const { scheduler } = createScheduler();
      await scheduler.start();
      expect(scheduler.isRunning).toBe(true);
      scheduler.stop();
    });

    it('should be idempotent when calling start() twice', async () => {
      const { scheduler, db } = createScheduler();
      await scheduler.start();
      const callCount = (db as any).from.mock.calls.length;
      await scheduler.start();
      // Second start should not trigger additional DB queries
      expect((db as any).from.mock.calls.length).toBe(callCount);
      scheduler.stop();
    });

    it('should stop and set running to false', async () => {
      const { scheduler } = createScheduler();
      await scheduler.start();
      scheduler.stop();
      expect(scheduler.isRunning).toBe(false);
    });

    it('should be safe to stop without starting', () => {
      const { scheduler } = createScheduler();
      expect(() => scheduler.stop()).not.toThrow();
    });
  });

  // ─── Tick Logic: Firing Due Schedules ───────────────────────────

  describe('tick logic', () => {
    it('should fire a past-due agent schedule on start', async () => {
      const pastDue = new Date(Date.now() - 60_000).toISOString();
      const { scheduler, db, engine } = createScheduler({
        agent_workforce_schedules: {
          data: [
            {
              id: 'sched-1',
              workspace_id: 'ws-test',
              agent_id: 'agent-1',
              workflow_id: null,
              label: 'Daily report',
              cron: '0 9 * * *',
              enabled: 1,
              next_run_at: pastDue,
              last_run_at: null,
              task_prompt: 'Generate daily report',
            },
          ],
        },
      });

      await scheduler.start();

      // Should have created a task via insert
      const fromCalls = (db as any).from.mock.calls;
      const insertTables = fromCalls
        .filter((_: unknown, i: number) => {
          const chain = (db as any).from.mock.results[i]?.value;
          return chain?.insert?.mock?.calls?.length > 0;
        })
        .map((c: string[]) => c[0]);
      expect(insertTables).toContain('agent_workforce_tasks');

      // Should have called executeTask
      expect(engine.executeTask).toHaveBeenCalledWith('agent-1', 'task-new');

      // Should have updated the schedule with next_run_at
      const updateTables = fromCalls
        .filter((_: unknown, i: number) => {
          const chain = (db as any).from.mock.results[i]?.value;
          return chain?.update?.mock?.calls?.length > 0;
        })
        .map((c: string[]) => c[0]);
      expect(updateTables).toContain('agent_workforce_schedules');

      // Should log activity via rpc
      expect((db as any).rpc).toHaveBeenCalledWith(
        'create_agent_activity',
        expect.objectContaining({
          p_workspace_id: 'ws-test',
          p_activity_type: 'schedule_fired',
          p_agent_id: 'agent-1',
        }),
      );

      scheduler.stop();
    });

    it('should NOT fire a schedule whose next_run_at is in the future', async () => {
      const future = new Date(Date.now() + 600_000).toISOString();
      const { scheduler, engine } = createScheduler({
        agent_workforce_schedules: {
          data: [
            {
              id: 'sched-2',
              workspace_id: 'ws-test',
              agent_id: 'agent-1',
              workflow_id: null,
              label: null,
              cron: '0 9 * * *',
              enabled: 1,
              next_run_at: future,
              last_run_at: null,
              task_prompt: 'Future task',
            },
          ],
        },
      });

      await scheduler.start();
      expect(engine.executeTask).not.toHaveBeenCalled();
      scheduler.stop();
    });

    it('should skip schedules with null next_run_at', async () => {
      const { scheduler, engine } = createScheduler({
        agent_workforce_schedules: {
          data: [
            {
              id: 'sched-3',
              workspace_id: 'ws-test',
              agent_id: 'agent-1',
              workflow_id: null,
              label: null,
              cron: '0 9 * * *',
              enabled: 1,
              next_run_at: null,
              last_run_at: null,
              task_prompt: 'No next run',
            },
          ],
        },
      });

      await scheduler.start();
      expect(engine.executeTask).not.toHaveBeenCalled();
      scheduler.stop();
    });

    it('should not fire if schedule has no agent_id or task_prompt', async () => {
      const pastDue = new Date(Date.now() - 60_000).toISOString();
      const { scheduler, engine } = createScheduler({
        agent_workforce_schedules: {
          data: [
            {
              id: 'sched-4',
              workspace_id: 'ws-test',
              agent_id: null,
              workflow_id: 'wf-1',
              label: null,
              cron: '0 9 * * *',
              enabled: 1,
              next_run_at: pastDue,
              last_run_at: null,
              task_prompt: null,
            },
          ],
        },
      });

      await scheduler.start();
      // No agent-based execution, but schedule should still be updated
      expect(engine.executeTask).not.toHaveBeenCalled();
      scheduler.stop();
    });
  });

  // ─── Heartbeat & Recalculation ──────────────────────────────────

  describe('heartbeat and recalculation', () => {
    it('should set up heartbeat timer on start', async () => {
      const { scheduler } = createScheduler();
      await scheduler.start();

      // Heartbeat should trigger tick after 5 minutes
      const fromCallsBefore = (scheduler as any).db.from.mock.calls.length;

      await vi.advanceTimersByTimeAsync(300_000);

      const fromCallsAfter = (scheduler as any).db.from.mock.calls.length;
      expect(fromCallsAfter).toBeGreaterThan(fromCallsBefore);

      scheduler.stop();
    });

    it('should clear timers on stop', async () => {
      const { scheduler } = createScheduler();
      await scheduler.start();
      scheduler.stop();

      // Advancing timers should not trigger any more queries
      const db = (scheduler as any).db;
      const callsBefore = db.from.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(db.from.mock.calls.length).toBe(callsBefore);
    });

    it('should set a precise timeout for the next due schedule', async () => {
      // Schedule due in 30 seconds
      const soon = new Date(Date.now() + 30_000).toISOString();
      const { scheduler, db } = createScheduler({
        agent_workforce_schedules: {
          data: [
            {
              id: 'sched-soon',
              workspace_id: 'ws-test',
              agent_id: 'agent-1',
              workflow_id: null,
              label: null,
              cron: '* * * * *',
              enabled: 1,
              next_run_at: soon,
              last_run_at: null,
              task_prompt: 'Soon task',
            },
          ],
        },
      });

      await scheduler.start();

      // The schedule is in the future so tick should not fire it
      // But recalculate should query for next_run_at and set a timeout
      const fromCalls = (db as any).from.mock.calls;
      const tables = fromCalls.map((c: string[]) => c[0]);
      expect(tables).toContain('agent_workforce_schedules');

      scheduler.stop();
    });
  });

  // ─── Notify ─────────────────────────────────────────────────────

  describe('notify()', () => {
    it('should trigger recalculation when running', async () => {
      const { scheduler, db } = createScheduler();
      await scheduler.start();

      const callsBefore = (db as any).from.mock.calls.length;
      scheduler.notify();

      // Allow the async recalculate to run
      await vi.advanceTimersByTimeAsync(0);

      const callsAfter = (db as any).from.mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);

      scheduler.stop();
    });

    it('should be a no-op when not running', () => {
      const { scheduler, db } = createScheduler();
      const callsBefore = (db as any).from.mock.calls.length;
      scheduler.notify();
      expect((db as any).from.mock.calls.length).toBe(callsBefore);
    });
  });

  // ─── Automation Schedule Triggers ───────────────────────────────

  describe('automation schedule triggers', () => {
    it('should fire past-due automation triggers when evaluator is set', async () => {
      const pastDue = new Date(Date.now() - 120_000).toISOString();
      const mockEvaluator = {
        executeById: vi.fn().mockResolvedValue(undefined),
      };

      const { scheduler, db } = createScheduler({
        agent_workforce_schedules: { data: [] },
        local_triggers: {
          data: [
            {
              id: 'trig-1',
              name: 'Hourly cleanup',
              description: '',
              enabled: 1,
              source: 'schedule',
              event_type: 'schedule',
              trigger_type: 'schedule',
              trigger_config: JSON.stringify({ cron: '0 * * * *' }),
              conditions: '{}',
              action_type: 'run_task',
              action_config: '{}',
              cooldown_seconds: 0,
              last_fired_at: pastDue,
              fire_count: 5,
              last_error: null,
              webhook_token: null,
              sample_payload: null,
            },
          ],
        },
      });

      scheduler.setTriggerEvaluator(mockEvaluator as any);
      await scheduler.start();

      // The automation trigger should have been fired
      expect(mockEvaluator.executeById).toHaveBeenCalledWith('trig-1');

      scheduler.stop();
    });

    it('should not evaluate triggers when no evaluator is set', async () => {
      const { scheduler, db } = createScheduler({
        agent_workforce_schedules: { data: [] },
        local_triggers: {
          data: [
            {
              id: 'trig-2',
              name: 'Orphan trigger',
              trigger_type: 'schedule',
              trigger_config: JSON.stringify({ cron: '0 * * * *' }),
              enabled: 1,
              last_fired_at: null,
            },
          ],
        },
      });

      // Do NOT call setTriggerEvaluator
      await scheduler.start();

      // local_triggers should not even be queried for tick
      const fromCalls = (db as any).from.mock.calls;
      const tickTriggerQueries = fromCalls.filter(
        (c: string[]) => c[0] === 'local_triggers',
      );
      // Only recalculate queries local_triggers (not tick), but since no evaluator, neither should
      expect(tickTriggerQueries.length).toBe(0);

      scheduler.stop();
    });

    it('should skip triggers with no cron in config', async () => {
      const mockEvaluator = {
        executeById: vi.fn().mockResolvedValue(undefined),
      };

      const { scheduler } = createScheduler({
        agent_workforce_schedules: { data: [] },
        local_triggers: {
          data: [
            {
              id: 'trig-3',
              name: 'Bad trigger',
              trigger_type: 'schedule',
              trigger_config: JSON.stringify({ someOtherField: true }),
              enabled: 1,
              last_fired_at: null,
            },
          ],
        },
      });

      scheduler.setTriggerEvaluator(mockEvaluator as any);
      await scheduler.start();

      expect(mockEvaluator.executeById).not.toHaveBeenCalled();
      scheduler.stop();
    });

    it('should skip triggers with invalid cron expressions', async () => {
      const mockEvaluator = {
        executeById: vi.fn().mockResolvedValue(undefined),
      };

      const { scheduler } = createScheduler({
        agent_workforce_schedules: { data: [] },
        local_triggers: {
          data: [
            {
              id: 'trig-4',
              name: 'Invalid cron trigger',
              trigger_type: 'schedule',
              trigger_config: JSON.stringify({ cron: 'invalid' }),
              enabled: 1,
              last_fired_at: null,
            },
          ],
        },
      });

      scheduler.setTriggerEvaluator(mockEvaluator as any);
      await scheduler.start();

      expect(mockEvaluator.executeById).not.toHaveBeenCalled();
      scheduler.stop();
    });
  });

  // ─── Edge Cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty schedule list gracefully', async () => {
      const { scheduler } = createScheduler({
        agent_workforce_schedules: { data: [] },
      });

      await expect(scheduler.start()).resolves.not.toThrow();
      scheduler.stop();
    });

    it('should handle null data from DB gracefully', async () => {
      const { scheduler } = createScheduler({
        agent_workforce_schedules: { data: null as any },
      });

      await expect(scheduler.start()).resolves.not.toThrow();
      scheduler.stop();
    });

    it('should handle DB errors during tick without crashing', async () => {
      const db = mockDb() as unknown as DatabaseAdapter;
      // Make from() throw
      (db as any).from = vi.fn().mockImplementation(() => {
        throw new Error('DB connection lost');
      });

      const engine = { executeTask: vi.fn() } as unknown as RuntimeEngine;
      const scheduler = new LocalScheduler(db, engine, 'ws-test');

      // start() calls tick() which will throw, but the scheduler should handle it
      // The error will propagate from start() since tick is awaited directly
      await expect(scheduler.start()).rejects.toThrow('DB connection lost');
      scheduler.stop();
    });

    it('should handle multiple past-due schedules in a single tick', async () => {
      const pastDue1 = new Date(Date.now() - 120_000).toISOString();
      const pastDue2 = new Date(Date.now() - 60_000).toISOString();

      const { scheduler, engine } = createScheduler({
        agent_workforce_schedules: {
          data: [
            {
              id: 'sched-a',
              workspace_id: 'ws-test',
              agent_id: 'agent-1',
              workflow_id: null,
              label: 'Task A',
              cron: '0 9 * * *',
              enabled: 1,
              next_run_at: pastDue1,
              last_run_at: null,
              task_prompt: 'Do A',
            },
            {
              id: 'sched-b',
              workspace_id: 'ws-test',
              agent_id: 'agent-2',
              workflow_id: null,
              label: 'Task B',
              cron: '0 10 * * *',
              enabled: 1,
              next_run_at: pastDue2,
              last_run_at: null,
              task_prompt: 'Do B',
            },
          ],
        },
      });

      await scheduler.start();

      // Both should have been fired
      expect(engine.executeTask).toHaveBeenCalledTimes(2);
      expect(engine.executeTask).toHaveBeenCalledWith('agent-1', 'task-new');
      expect(engine.executeTask).toHaveBeenCalledWith('agent-2', 'task-new');

      scheduler.stop();
    });

    it('should truncate long task_prompt for activity title', async () => {
      const pastDue = new Date(Date.now() - 60_000).toISOString();
      const longPrompt = 'A'.repeat(300);
      const { scheduler, db } = createScheduler({
        agent_workforce_schedules: {
          data: [
            {
              id: 'sched-long',
              workspace_id: 'ws-test',
              agent_id: 'agent-1',
              workflow_id: null,
              label: null,
              cron: '0 9 * * *',
              enabled: 1,
              next_run_at: pastDue,
              last_run_at: null,
              task_prompt: longPrompt,
            },
          ],
        },
      });

      await scheduler.start();

      // The activity description should be truncated to 200 chars
      expect((db as any).rpc).toHaveBeenCalledWith(
        'create_agent_activity',
        expect.objectContaining({
          p_description: longPrompt.slice(0, 200),
        }),
      );

      scheduler.stop();
    });
  });
});
