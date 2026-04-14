import { describe, it, expect, vi } from 'vitest';
import { StaleTaskCleanupExperiment } from '../experiments/stale-task-cleanup.js';
import type { ExperimentContext } from '../experiment-types.js';

/**
 * DB stub for the validate() path. Supports the single query the
 * validation does: select from agent_workforce_tasks filtered by
 * status='in_progress' + updated_at < cutoff.
 */
function buildDb(tasks: Array<Record<string, unknown>>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    lt: () => Promise.resolve({ data: tasks, error: null }),
  };
  return { from: vi.fn().mockReturnValue(chain) };
}

function makeCtx(tasks: Array<Record<string, unknown>>): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: buildDb(tasks) as any,
    workspaceId: 'ws-1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

describe('StaleTaskCleanupExperiment.validate()', () => {
  const exp = new StaleTaskCleanupExperiment();

  it('returns held when no stale tasks exist at validation time', async () => {
    const ctx = makeCtx([]);
    const result = await exp.validate!(
      {
        cleaned_task_ids: ['t1', 't2'],
        affected_agent_ids: ['a1', 'a2'],
      },
      ctx,
    );
    expect(result.outcome).toBe('held');
    expect(result.summary).toContain('cleanup held');
    expect(result.evidence.cleaned_task_count).toBe(2);
    expect(result.evidence.affected_agent_count).toBe(2);
    expect(result.evidence.current_stale_from_reset_agents).toBe(0);
  });

  it('returns held when stale tasks exist but are owned by OTHER agents', async () => {
    const ctx = makeCtx([
      { id: 'new-zombie', agent_id: 'a99', title: 'unrelated', started_at: '2026-04-14T10:00:00Z', updated_at: '2026-04-14T10:00:00Z', status: 'in_progress' },
    ]);
    const result = await exp.validate!(
      {
        cleaned_task_ids: ['t1'],
        affected_agent_ids: ['a1', 'a2'],
      },
      ctx,
    );
    expect(result.outcome).toBe('held');
  });

  it('returns failed when a reset agent has a NEW stale task (rebound)', async () => {
    const ctx = makeCtx([
      { id: 'new-zombie', agent_id: 'a2', title: 'rebounded work', started_at: '2026-04-14T10:00:00Z', updated_at: '2026-04-14T10:00:00Z', status: 'in_progress' },
    ]);
    const result = await exp.validate!(
      {
        cleaned_task_ids: ['t1'],
        affected_agent_ids: ['a1', 'a2'],
      },
      ctx,
    );
    expect(result.outcome).toBe('failed');
    expect(result.summary).toContain('cleanup rebounded');
    expect(result.evidence.rebounds).toHaveLength(1);
    const rebounds = result.evidence.rebounds as Array<{ task_id: string; agent_id: string }>;
    expect(rebounds[0].task_id).toBe('new-zombie');
    expect(rebounds[0].agent_id).toBe('a2');
  });

  it('returns failed when an original task appears resurrected as in_progress', async () => {
    const ctx = makeCtx([
      { id: 't1', agent_id: 'a99', title: 'resurrected', started_at: '2026-04-14T10:00:00Z', updated_at: '2026-04-14T10:00:00Z', status: 'in_progress' },
    ]);
    const result = await exp.validate!(
      {
        cleaned_task_ids: ['t1'],
        affected_agent_ids: ['a1'],
      },
      ctx,
    );
    expect(result.outcome).toBe('failed');
    expect(result.evidence.resurrected_task_ids).toEqual(['t1']);
  });

  it('returns inconclusive when baseline has no affected agents', async () => {
    const ctx = makeCtx([]);
    const result = await exp.validate!(
      { cleaned_task_ids: [], affected_agent_ids: [] },
      ctx,
    );
    expect(result.outcome).toBe('inconclusive');
    expect(result.summary).toContain('nothing to validate');
  });

  it('handles missing baseline fields gracefully', async () => {
    const ctx = makeCtx([]);
    // Baseline missing both fields — should hit the inconclusive guard.
    const result = await exp.validate!({}, ctx);
    expect(result.outcome).toBe('inconclusive');
  });

  it('separates rebounds from unrelated stale tasks in evidence', async () => {
    const ctx = makeCtx([
      { id: 'rebound-task', agent_id: 'a1', title: 'bad', started_at: '2026-04-14T10:00:00Z', updated_at: '2026-04-14T10:00:00Z', status: 'in_progress' },
      { id: 'unrelated-stale', agent_id: 'a99', title: 'other', started_at: '2026-04-14T10:00:00Z', updated_at: '2026-04-14T10:00:00Z', status: 'in_progress' },
    ]);
    const result = await exp.validate!(
      { cleaned_task_ids: ['t1'], affected_agent_ids: ['a1'] },
      ctx,
    );
    expect(result.outcome).toBe('failed');
    const rebounds = result.evidence.rebounds as Array<{ task_id: string }>;
    expect(rebounds).toHaveLength(1); // only a1's task counts
    expect(rebounds[0].task_id).toBe('rebound-task');
  });
});
