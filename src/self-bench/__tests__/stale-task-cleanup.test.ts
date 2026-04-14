import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StaleTaskCleanupExperiment } from '../experiments/stale-task-cleanup.js';
import type { Experiment, ExperimentContext, ProbeResult, Verdict } from '../experiment-types.js';

/**
 * In-memory DB stub matching the surface the experiment uses:
 *   from('agent_workforce_tasks').select(...).eq('status', 'in_progress').lt('updated_at', cutoff)
 *   from('agent_workforce_tasks').update(patch).eq('id', id)
 *   from('agent_workforce_agents').update(patch).eq('id', id)
 *
 * Enough to exercise probe + intervene end-to-end against realistic
 * seed data.
 */
function buildDb(initial: {
  tasks: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_workforce_tasks: initial.tasks,
    agent_workforce_agents: initial.agents,
  };
  const updates: Array<{ table: string; patch: Record<string, unknown>; id: string }> = [];

  function makeBuilder(table: string) {
    const filters: Array<{ col: string; op: 'eq' | 'lt'; val: unknown }> = [];
    const apply = () => tables[table].filter((r) =>
      filters.every((f) => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'lt') return String(r[f.col] ?? '') < String(f.val);
        return true;
      }),
    );
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, op: 'eq', val }); return builder; };
    builder.lt = (col: string, val: unknown) => { filters.push({ col, op: 'lt', val }); return builder; };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
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
    },
    tables,
    updates,
  };
}

function makeCtx(env: ReturnType<typeof buildDb>): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: env.db as any,
    workspaceId: 'ws-1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

const now = () => Date.now();

function minutesAgo(n: number): string {
  return new Date(now() - n * 60 * 1000).toISOString();
}

describe('StaleTaskCleanupExperiment', () => {
  const exp: Experiment = new StaleTaskCleanupExperiment();

  let env: ReturnType<typeof buildDb>;

  beforeEach(() => {
    env = buildDb({
      tasks: [
        // Fresh in_progress task — not eligible
        { id: 'fresh', agent_id: 'a1', title: 'fresh task', status: 'in_progress', started_at: minutesAgo(2), updated_at: minutesAgo(1) },
        // Stuck for 15 minutes — eligible
        { id: 'stuck', agent_id: 'a2', title: 'stuck task', status: 'in_progress', started_at: minutesAgo(15), updated_at: minutesAgo(15) },
        // Stuck for 30 minutes, different agent — eligible
        { id: 'zombie', agent_id: 'a3', title: 'zombie task', status: 'in_progress', started_at: minutesAgo(30), updated_at: minutesAgo(30) },
        // Completed — not eligible (different status)
        { id: 'done', agent_id: 'a1', title: 'done task', status: 'completed', started_at: minutesAgo(20), updated_at: minutesAgo(18) },
        // Pending — not eligible (different status)
        { id: 'pending', agent_id: 'a4', title: 'queued task', status: 'pending', started_at: null, updated_at: minutesAgo(20) },
      ],
      agents: [
        { id: 'a1', status: 'working' },
        { id: 'a2', status: 'working' },
        { id: 'a3', status: 'working' },
        { id: 'a4', status: 'idle' },
      ],
    });
  });

  it('probe finds only in_progress tasks with stale updated_at', async () => {
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { stale_count: number; stale_tasks: Array<{ task_id: string }> };
    expect(ev.stale_count).toBe(2);
    const ids = ev.stale_tasks.map((t) => t.task_id).sort();
    expect(ids).toEqual(['stuck', 'zombie']);
  });

  it('probe ignores completed and pending tasks', async () => {
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { stale_tasks: Array<{ task_id: string }> };
    const ids = ev.stale_tasks.map((t) => t.task_id);
    expect(ids).not.toContain('done');
    expect(ids).not.toContain('pending');
  });

  it('probe ignores fresh in_progress tasks', async () => {
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { stale_tasks: Array<{ task_id: string }> };
    const ids = ev.stale_tasks.map((t) => t.task_id);
    expect(ids).not.toContain('fresh');
  });

  it('judges empty result as pass', async () => {
    const cleanEnv = buildDb({ tasks: [
      { id: 'only-fresh', agent_id: 'a1', title: 'fresh', status: 'in_progress', started_at: minutesAgo(2), updated_at: minutesAgo(1) },
    ], agents: [{ id: 'a1', status: 'working' }] });
    const result = await exp.probe(makeCtx(cleanEnv));
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('judges non-empty stale list as warning (self-healing, not fail)', async () => {
    const result = await exp.probe(makeCtx(env));
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('intervene marks every stale task as failed with correct metadata', async () => {
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('warning' as Verdict, result, ctx);
    expect(intervention).not.toBeNull();

    const stuck = env.tables.agent_workforce_tasks.find((t) => t.id === 'stuck')!;
    const zombie = env.tables.agent_workforce_tasks.find((t) => t.id === 'zombie')!;
    expect(stuck.status).toBe('failed');
    expect(zombie.status).toBe('failed');
    expect(stuck.failure_category).toBe('stale_abandoned');
    expect(zombie.failure_category).toBe('stale_abandoned');
    expect(typeof stuck.error_message).toBe('string');
    expect(String(stuck.error_message)).toContain('stale-task-cleanup');
    expect(typeof stuck.completed_at).toBe('string');
  });

  it('intervene does NOT touch non-stale tasks', async () => {
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    await exp.intervene!('warning' as Verdict, result, ctx);

    const fresh = env.tables.agent_workforce_tasks.find((t) => t.id === 'fresh')!;
    const done = env.tables.agent_workforce_tasks.find((t) => t.id === 'done')!;
    const pending = env.tables.agent_workforce_tasks.find((t) => t.id === 'pending')!;

    expect(fresh.status).toBe('in_progress');
    expect(done.status).toBe('completed');
    expect(pending.status).toBe('pending');
  });

  it('intervene resets affected agents to idle', async () => {
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    await exp.intervene!('warning' as Verdict, result, ctx);

    const a2 = env.tables.agent_workforce_agents.find((a) => a.id === 'a2')!;
    const a3 = env.tables.agent_workforce_agents.find((a) => a.id === 'a3')!;
    expect(a2.status).toBe('idle');
    expect(a3.status).toBe('idle');
  });

  it('intervene does NOT touch agents whose only task was fresh', async () => {
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    await exp.intervene!('warning' as Verdict, result, ctx);

    // a1 owns 'fresh' (in_progress) and 'done' — neither triggers cleanup
    const a1 = env.tables.agent_workforce_agents.find((a) => a.id === 'a1')!;
    expect(a1.status).toBe('working');
  });

  it('intervene returns null when no stale tasks exist', async () => {
    const cleanEnv = buildDb({ tasks: [], agents: [] });
    const ctx = makeCtx(cleanEnv);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass' as Verdict, result, ctx);
    expect(intervention).toBeNull();
  });

  it('intervention details include cleaned task ids and affected agent ids', async () => {
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('warning' as Verdict, result, ctx);
    const details = intervention!.details;
    const cleaned = (details.cleaned_task_ids as string[]).sort();
    expect(cleaned).toEqual(['stuck', 'zombie']);
    const affected = (details.affected_agent_ids as string[]).sort();
    expect(affected).toEqual(['a2', 'a3']);
  });
});
