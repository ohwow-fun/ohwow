import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recordTriggerOutcome, TRIGGER_STUCK_THRESHOLD } from '../trigger-watchdog.js';

/**
 * Hand-rolled in-memory DB stub matching the surface the watchdog
 * helper uses: from(table).select(cols).eq(col,val).single() and
 * from(table).update(patch).eq(col,val). Each call records mutations
 * so tests can assert exact updates.
 */
function buildDb(seed: {
  tasks?: Array<Record<string, unknown>>;
  triggers?: Array<Record<string, unknown>>;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_workforce_tasks: seed.tasks ?? [],
    local_triggers: seed.triggers ?? [],
  };
  const updates: Array<{ table: string; patch: Record<string, unknown>; id: string }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  function makeBuilder(table: string) {
    const filters: Array<{ col: string; val: unknown }> = [];
    const apply = () => tables[table].filter((row) =>
      filters.every((f) => row[f.col] === f.val),
    );
    const builder: Record<string, unknown> = {};
    builder.select = (_cols?: string) => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val }); return builder; };
    builder.single = () => Promise.resolve({ data: apply()[0] ?? null, error: null });
    builder.update = (patch: Record<string, unknown>) => ({
      eq: (col: string, val: unknown) => {
        for (const row of tables[table]) {
          if (row[col] === val) {
            Object.assign(row, patch);
            updates.push({ table, patch, id: String(val) });
          }
        }
        return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
      },
    });
    return builder;
  }

  return {
    db: {
      from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
      rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      }),
    },
    tables,
    updates,
    rpcCalls,
  };
}

describe('recordTriggerOutcome', () => {
  let env: ReturnType<typeof buildDb>;

  beforeEach(() => {
    env = buildDb({
      tasks: [
        { id: 'task-linked', workspace_id: 'ws-1', agent_id: 'agent-1', source_trigger_id: 'trig-1' },
        { id: 'task-unlinked', workspace_id: 'ws-1', agent_id: 'agent-1', source_trigger_id: null },
      ],
      triggers: [
        { id: 'trig-1', name: 'diary-writer', consecutive_failures: 0, last_succeeded_at: null },
      ],
    });
  });

  it('is a no-op for tasks with no source_trigger_id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-unlinked', 'success');
    expect(env.updates).toHaveLength(0);
    expect(env.rpcCalls).toHaveLength(0);
  });

  it('is a no-op for unknown task ids', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-does-not-exist', 'failure');
    expect(env.updates).toHaveLength(0);
  });

  it('success stamps last_succeeded_at and resets consecutive_failures', async () => {
    env.tables.local_triggers[0].consecutive_failures = 5;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-linked', 'success');
    const trig = env.tables.local_triggers[0];
    expect(trig.consecutive_failures).toBe(0);
    expect(typeof trig.last_succeeded_at).toBe('string');
  });

  it('failure increments consecutive_failures by 1', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-linked', 'failure');
    expect(env.tables.local_triggers[0].consecutive_failures).toBe(1);
  });

  it('failure accumulates across calls', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-linked', 'failure');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-linked', 'failure');
    expect(env.tables.local_triggers[0].consecutive_failures).toBe(2);
  });

  it('does NOT emit trigger_stuck activity below the threshold', async () => {
    for (let i = 0; i < TRIGGER_STUCK_THRESHOLD - 1; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await recordTriggerOutcome(env.db as any, 'task-linked', 'failure');
    }
    expect(env.rpcCalls.find((c) => c.name === 'create_agent_activity')).toBeUndefined();
  });

  it('emits trigger_stuck activity exactly once on the crossing failure', async () => {
    // Prime to one below threshold, then the next failure crosses.
    env.tables.local_triggers[0].consecutive_failures = TRIGGER_STUCK_THRESHOLD - 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-linked', 'failure');
    const activity = env.rpcCalls.find((c) => c.name === 'create_agent_activity');
    expect(activity).toBeDefined();
    expect(activity!.args.p_activity_type).toBe('trigger_stuck');
    expect(String(activity!.args.p_title)).toContain('diary-writer');
    expect(String(activity!.args.p_title)).toContain(String(TRIGGER_STUCK_THRESHOLD));

    // Subsequent failures keep incrementing but do NOT re-emit
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-linked', 'failure');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-linked', 'failure');
    const stuckAlerts = env.rpcCalls.filter(
      (c) => c.name === 'create_agent_activity'
        && (c.args.p_activity_type as string) === 'trigger_stuck',
    );
    expect(stuckAlerts).toHaveLength(1);
    expect(env.tables.local_triggers[0].consecutive_failures).toBe(TRIGGER_STUCK_THRESHOLD + 2);
  });

  it('re-arms the stuck alert after a success/failure cycle', async () => {
    // Cross threshold → one alert
    env.tables.local_triggers[0].consecutive_failures = TRIGGER_STUCK_THRESHOLD - 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-linked', 'failure');

    // Success resets
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordTriggerOutcome(env.db as any, 'task-linked', 'success');
    expect(env.tables.local_triggers[0].consecutive_failures).toBe(0);

    // Cross the threshold a second time → should emit a SECOND alert
    for (let i = 0; i < TRIGGER_STUCK_THRESHOLD; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await recordTriggerOutcome(env.db as any, 'task-linked', 'failure');
    }
    const stuckAlerts = env.rpcCalls.filter(
      (c) => c.name === 'create_agent_activity'
        && (c.args.p_activity_type as string) === 'trigger_stuck',
    );
    expect(stuckAlerts).toHaveLength(2);
  });

  it('swallows errors and does not throw', async () => {
    const brokenDb = {
      from: () => { throw new Error('db unavailable'); },
      rpc: () => Promise.resolve({ data: null, error: null }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(recordTriggerOutcome(brokenDb as any, 'task-1', 'success')).resolves.toBeUndefined();
  });
});
