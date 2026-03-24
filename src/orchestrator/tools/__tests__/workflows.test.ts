import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listWorkflows, runWorkflow } from '../workflows.js';
import type { LocalToolContext } from '../../local-tool-types.js';
import { makeCtx, mockEngine } from '../../../__tests__/helpers/mock-db.js';

// ─── Tests ───

describe('listWorkflows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns workflows from the database', async () => {
    const workflows = [
      { id: 'wf1', name: 'Daily Report', description: 'Generate daily report', status: 'active', run_count: 5 },
    ];
    const ctx = makeCtx({ agent_workforce_workflows: { data: workflows } });
    const result = await listWorkflows(ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(workflows);
  });

  it('returns error when db query fails', async () => {
    const _ctx = makeCtx({
      agent_workforce_workflows: { data: null, error: { message: 'DB connection lost' } as unknown },
    });
    // The default makeCtx mock doesn't properly propagate errors on thenable,
    // so we build a custom db mock that returns the error via .then().
    const ctxWithError: LocalToolContext = {
      db: {
        from: vi.fn().mockImplementation(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const c: any = {};
          const methods = ['select', 'eq', 'order', 'limit'] as const;
          for (const m of methods) c[m] = vi.fn().mockReturnValue(c);
          c.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) =>
            resolve({ data: null, error: { message: 'DB connection lost' } }),
          );
          return c;
        }),
      } as unknown as LocalToolContext['db'],
      workspaceId: 'ws-1',
      engine: mockEngine as unknown as LocalToolContext['engine'],
      channels: {} as unknown as LocalToolContext['channels'],
      controlPlane: null,
    };

    const result = await listWorkflows(ctxWithError);
    expect(result.success).toBe(false);
    expect(result.error).toContain('DB connection lost');
  });

  it('returns empty array when no workflows exist', async () => {
    const ctx = makeCtx({ agent_workforce_workflows: { data: [] } });
    const result = await listWorkflows(ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });
});

describe('runWorkflow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when workflow_id is missing', async () => {
    const ctx = makeCtx();
    const result = await runWorkflow(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('workflow_id is required');
  });

  it('returns error when workflow is not found', async () => {
    const ctx = makeCtx({ agent_workforce_workflows: { data: null } });
    const result = await runWorkflow(ctx, { workflow_id: 'nonexistent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Workflow not found');
  });

  it('returns error when workflow belongs to different workspace', async () => {
    const ctx = makeCtx({
      agent_workforce_workflows: {
        data: { id: 'wf1', name: 'Test', workspace_id: 'ws-other', steps: '[]', run_count: 0 },
      },
    });
    const result = await runWorkflow(ctx, { workflow_id: 'wf1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not in your workspace');
  });

  it('returns error when workflow has no steps', async () => {
    const ctx = makeCtx({
      agent_workforce_workflows: {
        data: { id: 'wf1', name: 'Empty', workspace_id: 'ws-1', steps: '[]', run_count: 0 },
      },
    });
    const result = await runWorkflow(ctx, { workflow_id: 'wf1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no steps');
  });

  it('starts workflow execution and returns success immediately', async () => {
    mockEngine.executeTask.mockResolvedValue({
      success: true, taskId: 'task-1', status: 'completed', output: 'Done', tokensUsed: 100, costCents: 1,
    });
    const ctx = makeCtx({
      agent_workforce_workflows: {
        data: {
          id: 'wf1', name: 'Daily Report', workspace_id: 'ws-1',
          steps: JSON.stringify([
            { agent_id: 'a1', action: 'Write a report', step_type: 'agent_prompt' },
          ]),
          run_count: 2,
        },
      },
    });

    const result = await runWorkflow(ctx, { workflow_id: 'wf1' });
    expect(result.success).toBe(true);
    expect((result.data as { message: string }).message).toContain('Daily Report');
  });

  it('passes context between sequential steps', async () => {
    let callCount = 0;
    mockEngine.executeTask.mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        success: true, taskId: `task-${callCount}`, status: 'completed',
        output: `Output from step ${callCount}`, tokensUsed: 50, costCents: 0.5,
      });
    });

    const steps = [
      { agent_id: 'a1', action: 'Research topic', step_type: 'agent_prompt' },
      { agent_id: 'a2', action: 'Write article', step_type: 'agent_prompt' },
    ];
    const ctx = makeCtx({
      agent_workforce_workflows: {
        data: { id: 'wf1', name: 'Pipeline', workspace_id: 'ws-1', steps: JSON.stringify(steps), run_count: 0 },
      },
    });

    const result = await runWorkflow(ctx, { workflow_id: 'wf1' });
    expect(result.success).toBe(true);

    // Wait for async execution
    await vi.waitFor(() => expect(mockEngine.executeTask).toHaveBeenCalledTimes(2), { timeout: 1000 });
  });

  it('stops on step failure', async () => {
    mockEngine.executeTask
      .mockResolvedValueOnce({ success: false, taskId: 'task-1', status: 'failed', error: 'API error', tokensUsed: 10, costCents: 0.1 })
      .mockResolvedValueOnce({ success: true, taskId: 'task-2', status: 'completed', output: 'ok', tokensUsed: 10, costCents: 0.1 });

    const steps = [
      { agent_id: 'a1', action: 'Step 1', step_type: 'agent_prompt' },
      { agent_id: 'a2', action: 'Step 2', step_type: 'agent_prompt' },
    ];
    const ctx = makeCtx({
      agent_workforce_workflows: {
        data: { id: 'wf1', name: 'Pipeline', workspace_id: 'ws-1', steps: JSON.stringify(steps), run_count: 0 },
      },
    });

    await runWorkflow(ctx, { workflow_id: 'wf1' });

    // Wait deterministically for async execution to settle
    await vi.waitFor(() => expect(mockEngine.executeTask).toHaveBeenCalledTimes(1), { timeout: 1000 });
  });

  it('handles steps as native array (not JSON string)', async () => {
    mockEngine.executeTask.mockResolvedValue({
      success: true, taskId: 'task-1', status: 'completed', output: 'ok', tokensUsed: 10, costCents: 0.1,
    });
    const ctx = makeCtx({
      agent_workforce_workflows: {
        data: {
          id: 'wf1', name: 'ArraySteps', workspace_id: 'ws-1',
          steps: [{ agent_id: 'a1', action: 'Do it', step_type: 'agent_prompt' }],
          run_count: 0,
        },
      },
    });
    const result = await runWorkflow(ctx, { workflow_id: 'wf1' });
    expect(result.success).toBe(true);
  });

  it('parses steps from JSON string', async () => {
    mockEngine.executeTask.mockResolvedValue({
      success: true, taskId: 'task-1', status: 'completed', output: 'ok', tokensUsed: 10, costCents: 0.1,
    });

    const ctx = makeCtx({
      agent_workforce_workflows: {
        data: {
          id: 'wf1', name: 'StringSteps', workspace_id: 'ws-1',
          steps: '[{"agent_id":"a1","action":"Do it","step_type":"agent_prompt"}]',
          run_count: 0,
        },
      },
    });

    const result = await runWorkflow(ctx, { workflow_id: 'wf1' });
    expect(result.success).toBe(true);
  });
});
