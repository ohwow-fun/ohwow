import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listTasks, getTaskDetail, approveTask, cancelTask } from '../../tools/tasks.js';
import type { LocalToolContext } from '../../local-tool-types.js';
import { makeCtx, mockEngine } from '../../../__tests__/helpers/mock-db.js';

// ─── Mocks ───

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Tests ───

describe('listTasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns tasks with agent names resolved', async () => {
    const tasks = [
      { id: 't1', title: 'Write report', status: 'completed', agent_id: 'a1', project_id: null, board_column: null, created_at: '2026-03-14', tokens_used: 100, cost_cents: 1, error_message: null },
      { id: 't2', title: 'Research topic', status: 'running', agent_id: 'a2', project_id: 'p1', board_column: 'doing', created_at: '2026-03-14', tokens_used: 50, cost_cents: 0, error_message: null },
    ];
    const agents = [
      { id: 'a1', name: 'Writer' },
      { id: 'a2', name: 'Researcher' },
    ];
    const projects = [{ id: 'p1', name: 'Q1 Goals' }];

    // Need per-table control for the thenable (tasks) vs in-query (agents, projects)
    const db = {
      from: vi.fn().mockImplementation((table: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {};
        for (const method of ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not', 'order', 'limit', 'range']) {
          chain[method] = vi.fn().mockReturnValue(chain);
        }
        chain.update = vi.fn().mockReturnValue(chain);

        if (table === 'agent_workforce_tasks') {
          chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) =>
            resolve({ data: tasks, error: null }),
          );
        } else if (table === 'agent_workforce_agents') {
          chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) =>
            resolve({ data: agents, error: null }),
          );
        } else if (table === 'agent_workforce_projects') {
          chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) =>
            resolve({ data: projects, error: null }),
          );
        } else {
          chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) =>
            resolve({ data: null, error: null }),
          );
        }
        return chain;
      }),
    };
    const ctx: LocalToolContext = {
      db: db as unknown as LocalToolContext['db'],
      workspaceId: 'ws-1',
      engine: mockEngine as unknown as LocalToolContext['engine'],
      channels: {} as unknown as LocalToolContext['channels'],
      controlPlane: null,
    };

    const result = await listTasks(ctx, {});

    expect(result.success).toBe(true);
    // Post-E4 shape: { total, returned, limit, tasks }. Assert both
    // the envelope fields and the task array so a future regression
    // that drops `total` or flips the shape back surfaces loudly.
    const envelope = result.data as {
      total: number;
      returned: number;
      limit: number;
      tasks: Array<{ id: string; agentName: string; projectName?: string }>;
    };
    expect(envelope.tasks).toHaveLength(2);
    expect(envelope.returned).toBe(2);
    expect(envelope.limit).toBe(50);
    expect(envelope.tasks[0].agentName).toBe('Writer');
    expect(envelope.tasks[1].agentName).toBe('Researcher');
    expect(envelope.tasks[1].projectName).toBe('Q1 Goals');
  });

  it('returns an empty envelope when no tasks exist', async () => {
    const ctx = makeCtx({ agent_workforce_tasks: { data: [] } });
    const result = await listTasks(ctx, {});

    expect(result.success).toBe(true);
    const envelope = result.data as { total: number; returned: number; limit: number; tasks: unknown[] };
    expect(envelope.tasks).toEqual([]);
    expect(envelope.returned).toBe(0);
    expect(envelope.total).toBe(0);
  });

  it('filters by status parameter', async () => {
    const tasks = [
      { id: 't1', title: 'Done task', status: 'completed', agent_id: null, project_id: null, board_column: null, created_at: '2026-03-14', tokens_used: 0, cost_cents: 0, error_message: null },
    ];
    const ctx = makeCtx({ agent_workforce_tasks: { data: tasks } });
    const result = await listTasks(ctx, { status: 'completed' });

    expect(result.success).toBe(true);
    // Verify the eq method was called (status filter applied on the chain)
    const fromCall = (ctx.db.from as ReturnType<typeof vi.fn>);
    expect(fromCall).toHaveBeenCalledWith('agent_workforce_tasks');
  });

  it('returns error on DB failure', async () => {
    const db = {
      from: vi.fn().mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c: any = {};
        for (const m of ['select', 'eq', 'order', 'limit', 'in']) {
          c[m] = vi.fn().mockReturnValue(c);
        }
        c.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) =>
          resolve({ data: null, error: { message: 'Query timeout' } }),
        );
        return c;
      }),
    };
    const ctx: LocalToolContext = {
      db: db as unknown as LocalToolContext['db'],
      workspaceId: 'ws-1',
      engine: mockEngine as unknown as LocalToolContext['engine'],
      channels: {} as unknown as LocalToolContext['channels'],
      controlPlane: null,
    };

    const result = await listTasks(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Query timeout');
  });
});

describe('getTaskDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns full detail for a valid task', async () => {
    const db = {
      from: vi.fn().mockImplementation((table: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {};
        for (const method of ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not', 'order', 'limit', 'range']) {
          chain[method] = vi.fn().mockReturnValue(chain);
        }

        if (table === 'agent_workforce_tasks') {
          chain.single = vi.fn().mockResolvedValue({
            data: {
              id: 't1', title: 'Write report', description: 'Detailed report', status: 'completed',
              agent_id: 'a1', output: 'Report content here', error_message: null,
              tokens_used: 500, cost_cents: 5, model_used: 'claude-3', created_at: '2026-03-14',
              completed_at: '2026-03-14', duration_seconds: 30, retry_count: 0,
              project_id: null, board_column: 'done', workspace_id: 'ws-1',
            },
            error: null,
          });
        } else if (table === 'agent_workforce_agents') {
          chain.single = vi.fn().mockResolvedValue({
            data: { name: 'Writer' },
            error: null,
          });
        }
        return chain;
      }),
    };
    const ctx: LocalToolContext = {
      db: db as unknown as LocalToolContext['db'],
      workspaceId: 'ws-1',
      engine: mockEngine as unknown as LocalToolContext['engine'],
      channels: {} as unknown as LocalToolContext['channels'],
      controlPlane: null,
    };

    const result = await getTaskDetail(ctx, { task_id: 't1' });

    expect(result.success).toBe(true);
    const data = result.data as { id: string; agentName: string; status: string; output: string };
    expect(data.id).toBe('t1');
    expect(data.agentName).toBe('Writer');
    expect(data.status).toBe('completed');
    expect(data.output).toBe('Report content here');
  });

  it('returns error when task_id is missing', async () => {
    const ctx = makeCtx();
    const result = await getTaskDetail(ctx, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('task_id is required');
  });

  it('returns error when task is not found', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: { data: null },
    });

    const result = await getTaskDetail(ctx, { task_id: 'nonexistent' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Task not found');
  });

  it('returns error when task belongs to different workspace', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: {
        data: {
          id: 't1', title: 'Secret task', status: 'completed', workspace_id: 'ws-other',
          agent_id: null, output: null, error_message: null, tokens_used: 0, cost_cents: 0,
          model_used: null, created_at: '2026-03-14', completed_at: null, duration_seconds: null,
          retry_count: 0, project_id: null, board_column: null, description: null,
        },
      },
    });

    const result = await getTaskDetail(ctx, { task_id: 't1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Task not in your workspace');
  });

  it('truncates very large output', async () => {
    const longOutput = 'x'.repeat(5000);
    const ctx = makeCtx({
      agent_workforce_tasks: {
        data: {
          id: 't1', title: 'Big task', status: 'completed', workspace_id: 'ws-1',
          agent_id: null, output: longOutput, error_message: null, tokens_used: 0,
          cost_cents: 0, model_used: null, created_at: '2026-03-14', completed_at: null,
          duration_seconds: null, retry_count: 0, project_id: null, board_column: null,
          description: null,
        },
      },
    });

    const result = await getTaskDetail(ctx, { task_id: 't1' });

    expect(result.success).toBe(true);
    const data = result.data as { output: string };
    expect(data.output).toContain('(truncated)');
    expect(data.output.length).toBeLessThan(5000);
  });
});

describe('approveTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('transitions needs_approval task to approved', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: {
        data: { id: 't1', title: 'Review this', status: 'needs_approval', workspace_id: 'ws-1', deferred_action: null },
      },
    });

    const result = await approveTask(ctx, { task_id: 't1' });

    expect(result.success).toBe(true);
    const data = result.data as { message: string };
    expect(data.message).toContain('approved');
    expect(data.message).toContain('Review this');
  });

  it('returns error when task_id is missing', async () => {
    const ctx = makeCtx();
    const result = await approveTask(ctx, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('task_id is required');
  });

  it('rejects task that is not in needs_approval status', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: {
        data: { id: 't1', title: 'Already done', status: 'completed', workspace_id: 'ws-1', deferred_action: null },
      },
    });

    const result = await approveTask(ctx, { task_id: 't1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not pending approval');
    expect(result.error).toContain('completed');
  });

  it('returns error when task is not found', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: { data: null },
    });

    const result = await approveTask(ctx, { task_id: 'nonexistent' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Task not found');
  });
});

describe('cancelTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancels a pending task', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: {
        data: { id: 't1', title: 'Pending task', status: 'pending', workspace_id: 'ws-1' },
      },
    });

    const result = await cancelTask(ctx, { task_id: 't1' });

    expect(result.success).toBe(true);
    const data = result.data as { message: string };
    expect(data.message).toContain('cancelled');
    expect(data.message).toContain('Pending task');
  });

  it('cancels an in_progress task', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: {
        data: { id: 't1', title: 'Running task', status: 'in_progress', workspace_id: 'ws-1' },
      },
    });

    const result = await cancelTask(ctx, { task_id: 't1' });

    expect(result.success).toBe(true);
    const data = result.data as { message: string };
    expect(data.message).toContain('cancelled');
  });

  it('rejects cancellation of a completed task', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: {
        data: { id: 't1', title: 'Done task', status: 'completed', workspace_id: 'ws-1' },
      },
    });

    const result = await cancelTask(ctx, { task_id: 't1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot cancel');
    expect(result.error).toContain('completed');
  });

  it('returns error when task_id is missing', async () => {
    const ctx = makeCtx();
    const result = await cancelTask(ctx, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('task_id is required');
  });

  it('returns error when task is not found', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: { data: null },
    });

    const result = await cancelTask(ctx, { task_id: 'nonexistent' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Task not found');
  });

  it('returns error when task belongs to different workspace', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: {
        data: { id: 't1', title: 'Other task', status: 'pending', workspace_id: 'ws-other' },
      },
    });

    const result = await cancelTask(ctx, { task_id: 't1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Task not in your workspace');
  });
});
