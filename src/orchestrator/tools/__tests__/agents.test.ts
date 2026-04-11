import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listAgents, runAgent, updateAgentStatus } from '../../tools/agents.js';
import type { LocalToolContext } from '../../local-tool-types.js';
import { makeCtx, mockEngine } from '../../../__tests__/helpers/mock-db.js';

// ─── Mocks ───

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Tests ───

describe('listAgents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns formatted agent list with schedules', async () => {
    const agents = [
      { id: 'a1', name: 'Writer', role: 'content', status: 'idle', paused: 0 },
      { id: 'a2', name: 'Researcher', role: 'research', status: 'idle', paused: 0 },
    ];
    const schedules = [
      { agent_id: 'a1', cron: '0 9 * * *', last_run_at: '2026-03-14T09:00:00Z', enabled: 1 },
    ];
    const ctx = makeCtx({
      agent_workforce_agents: { data: agents },
      agent_workforce_schedules: { data: schedules },
    });

    const result = await listAgents(ctx);

    expect(result.success).toBe(true);
    const data = result.data as Array<{ id: string; name: string; schedules: unknown[] }>;
    expect(data).toHaveLength(2);
    expect(data[0].name).toBe('Writer');
    expect(data[0].schedules).toHaveLength(1);
    expect(data[1].schedules).toHaveLength(0);
  });

  it('returns empty data when no agents exist', async () => {
    const ctx = makeCtx({ agent_workforce_agents: { data: [] } });
    const result = await listAgents(ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('returns error on DB failure', async () => {
    // Need to override the thenable to return an error
    const db = {
      from: vi.fn().mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c: any = {};
        for (const m of ['select', 'eq', 'order', 'limit', 'in']) {
          c[m] = vi.fn().mockReturnValue(c);
        }
        c.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) =>
          resolve({ data: null, error: { message: 'Connection refused' } }),
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

    const result = await listAgents(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Connection refused');
  });
});

describe('runAgent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates task and executes with valid agent', async () => {
    mockEngine.executeTask.mockResolvedValue({
      status: 'completed',
      output: 'Task done successfully',
    });
    const ctx = makeCtx({
      agent_workforce_agents: {
        data: { id: 'a1', name: 'Writer', workspace_id: 'ws-1', config: '{}' },
      },
      agent_workforce_tasks: { data: null }, // maybeSingle returns null (no existing task)
    });

    const result = await runAgent(ctx, { agent_id: 'a1', prompt: 'Write a report' });

    expect(result.success).toBe(true);
    const data = result.data as { message: string; taskId: string; status: string };
    expect(data.message).toContain('Writer');
    expect(data.message).toContain('completed');
    expect(data.taskId).toBe('task-new');
    expect(mockEngine.executeTask).toHaveBeenCalledWith('a1', 'task-new', undefined);
  });

  it('returns error when agent_id is missing', async () => {
    const ctx = makeCtx();
    const result = await runAgent(ctx, { prompt: 'Write something' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('agent_id and prompt are required');
  });

  it('returns error when prompt is missing', async () => {
    const ctx = makeCtx();
    const result = await runAgent(ctx, { agent_id: 'a1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('agent_id and prompt are required');
  });

  it('returns error when agent is not found', async () => {
    const ctx = makeCtx({
      agent_workforce_agents: { data: null },
    });

    const result = await runAgent(ctx, { agent_id: 'nonexistent', prompt: 'Hello' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent not found');
  });

  it('returns error when agent belongs to different workspace', async () => {
    const ctx = makeCtx({
      agent_workforce_agents: {
        data: { id: 'a1', name: 'Writer', workspace_id: 'ws-other', config: '{}' },
      },
    });

    const result = await runAgent(ctx, { agent_id: 'a1', prompt: 'Hello' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent not in your workspace');
  });

  it('returns alreadyRunning message when agent has an active task', async () => {
    // Need per-table control: agents returns agent, tasks returns existing task via maybeSingle
    const db = {
      from: vi.fn().mockImplementation((table: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {};
        for (const method of ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not', 'order', 'limit', 'range']) {
          chain[method] = vi.fn().mockReturnValue(chain);
        }
        chain.update = vi.fn().mockReturnValue(chain);

        if (table === 'agent_workforce_agents') {
          chain.single = vi.fn().mockResolvedValue({
            data: { id: 'a1', name: 'Writer', workspace_id: 'ws-1', config: '{}' },
            error: null,
          });
        } else if (table === 'agent_workforce_tasks') {
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { id: 'task-existing', status: 'running', title: 'Previous task', created_at: '2026-03-14' },
            error: null,
          });
          chain.insert = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'task-new' }, error: null }),
            }),
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

    const result = await runAgent(ctx, { agent_id: 'a1', prompt: 'Another task' });

    expect(result.success).toBe(true);
    const data = result.data as { alreadyRunning: boolean; taskId: string };
    expect(data.alreadyRunning).toBe(true);
    expect(data.taskId).toBe('task-existing');
    expect(mockEngine.executeTask).not.toHaveBeenCalled();
  });

  it('handles engine execution timeout gracefully', async () => {
    // Make executeTask hang forever
    mockEngine.executeTask.mockImplementation(() => new Promise(() => {}));
    const ctx = makeCtx({
      agent_workforce_agents: {
        data: { id: 'a1', name: 'Writer', workspace_id: 'ws-1', config: '{}' },
      },
      agent_workforce_tasks: { data: null },
    });

    // We can't actually wait 2 minutes, so test the error path via rejection
    mockEngine.executeTask.mockRejectedValue(new Error('timeout'));
    const result = await runAgent(ctx, { agent_id: 'a1', prompt: 'Write something' });

    expect(result.success).toBe(true);
    const data = result.data as { message: string; taskId: string };
    expect(data.message).toContain('still working on the task');
    expect(data.taskId).toBe('task-new');
  });
});

describe('updateAgentStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pauses an agent successfully (action format)', async () => {
    const ctx = makeCtx({
      agent_workforce_agents: {
        data: { id: 'a1', name: 'Writer', paused: 0, status: 'idle', workspace_id: 'ws-1' },
      },
    });

    const result = await updateAgentStatus(ctx, { agent_id: 'a1', action: 'pause' });

    expect(result.success).toBe(true);
    const data = result.data as { message: string };
    expect(data.message).toContain('paused');
    expect(data.message).toContain('Writer');
  });

  it('pauses an agent successfully (legacy status format)', async () => {
    const ctx = makeCtx({
      agent_workforce_agents: {
        data: { id: 'a1', name: 'Writer', paused: 0, status: 'idle', workspace_id: 'ws-1' },
      },
    });

    const result = await updateAgentStatus(ctx, { agent_id: 'a1', status: 'paused' });

    expect(result.success).toBe(true);
    const data = result.data as { message: string };
    expect(data.message).toContain('paused');
    expect(data.message).toContain('Writer');
  });

  it('resumes an agent successfully', async () => {
    const ctx = makeCtx({
      agent_workforce_agents: {
        data: { id: 'a1', name: 'Writer', paused: 1, status: 'idle', workspace_id: 'ws-1' },
      },
    });

    const result = await updateAgentStatus(ctx, { agent_id: 'a1', action: 'resume' });

    expect(result.success).toBe(true);
    const data = result.data as { message: string };
    expect(data.message).toContain('resumed');
    expect(data.message).toContain('Writer');
  });

  it('returns error with invalid action', async () => {
    const ctx = makeCtx();
    const result = await updateAgentStatus(ctx, { agent_id: 'a1', action: 'active' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('action must be');
  });

  it('returns error when agent_id is missing', async () => {
    const ctx = makeCtx();

    const result = await updateAgentStatus(ctx, { action: 'pause' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent_id is required');
  });

  it('returns error when no action or status provided', async () => {
    const ctx = makeCtx();

    const result = await updateAgentStatus(ctx, { agent_id: 'a1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('action must be');
  });

  it('returns error when agent is currently working', async () => {
    const ctx = makeCtx({
      agent_workforce_agents: {
        data: { id: 'a1', name: 'Writer', paused: 0, status: 'working', workspace_id: 'ws-1' },
      },
    });

    const result = await updateAgentStatus(ctx, { agent_id: 'a1', action: 'pause' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('currently working');
    expect(result.error).toContain('Writer');
  });

  it('returns error when agent is not found', async () => {
    const ctx = makeCtx({
      agent_workforce_agents: { data: null },
    });

    const result = await updateAgentStatus(ctx, { agent_id: 'nonexistent', action: 'pause' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent not found');
  });

  it('returns error when agent belongs to different workspace', async () => {
    const ctx = makeCtx({
      agent_workforce_agents: {
        data: { id: 'a1', name: 'Writer', paused: 0, status: 'idle', workspace_id: 'ws-other' },
      },
    });

    const result = await updateAgentStatus(ctx, { agent_id: 'a1', action: 'pause' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent not in your workspace');
  });
});
