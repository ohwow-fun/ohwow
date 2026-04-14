import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleTaskFailure } from '../task-failure.js';
import { PermissionDeniedError } from '../filesystem/permission-error.js';

/**
 * Minimal stand-in for the RuntimeEngine `this` shape that
 * handleTaskFailure touches on the permission-denied path. Only the
 * four surfaces (db.from, db.rpc, emit, modelRouter/effects) need to
 * exist; the permission branch returns before reaching the retry
 * logic, cloud report, anomaly detection, or root-cause enrichment.
 */
function buildEngineStub() {
  const updates: Array<{ table: string; patch: Record<string, unknown>; id?: string }> = [];
  const events: Array<{ name: string; payload: unknown }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const makeSingle = (data: unknown) => Promise.resolve({ data, error: null });

  const db = {
    from: (table: string) => {
      const builder = {
        _patch: {} as Record<string, unknown>,
        select: (_cols: string) => ({
          eq: (_col: string, _val: string) => ({
            single: () => {
              if (table === 'agent_workforce_tasks') return makeSingle({ checkpoint_iteration: 7 });
              if (table === 'agent_workforce_agents') return makeSingle({ name: 'diary-writer' });
              return makeSingle(null);
            },
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          builder._patch = patch;
          return {
            eq: (_col: string, val: string) => {
              updates.push({ table, patch: builder._patch, id: val });
              return {
                then: (ok: () => void, _err: () => void) => { ok(); return Promise.resolve(); },
              };
            },
          };
        },
      };
      return builder;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  };

  const engine = {
    db,
    emit: (name: string, payload: unknown) => { events.push({ name, payload }); },
  };

  return { engine, updates, events, rpcCalls };
}

describe('handleTaskFailure — permission-denied routing', () => {
  let stub: ReturnType<typeof buildEngineStub>;

  beforeEach(() => {
    stub = buildEngineStub();
  });

  const permErr = new PermissionDeniedError({
    toolName: 'local_write_file',
    attemptedPath: '/Users/jesus/.ohwow/living-docs/diary/today.md',
    suggestedExact: '/Users/jesus/.ohwow/living-docs/diary/today.md',
    suggestedParent: '/Users/jesus/.ohwow/living-docs/diary',
    guardReason: 'Path is outside the allowed directories.',
  });

  it('routes PermissionDeniedError to status=needs_approval (not failed)', async () => {
    // @ts-expect-error — stub shape is narrower than RuntimeEngine
    const result = await handleTaskFailure.call(stub.engine, {
      error: permErr,
      taskId: 'task-1',
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      taskTitle: 'Write the daily diary',
      startTime: Date.now() - 5_000,
    });
    expect(result.status).toBe('needs_approval');
    expect(result.success).toBe(false);
  });

  it('writes approval_reason + permission_request JSON to the task row', async () => {
    // @ts-expect-error — stub shape is narrower than RuntimeEngine
    await handleTaskFailure.call(stub.engine, {
      error: permErr,
      taskId: 'task-2',
      agentId: 'agent-2',
      workspaceId: 'ws-2',
      taskTitle: 'Daily diary',
      startTime: Date.now() - 5_000,
    });
    const taskUpdate = stub.updates.find(
      (u) => u.table === 'agent_workforce_tasks' && u.patch.status === 'needs_approval',
    );
    expect(taskUpdate).toBeDefined();
    expect(taskUpdate!.patch.approval_reason).toBe('permission_denied');
    const payload = JSON.parse(taskUpdate!.patch.permission_request as string);
    expect(payload.tool_name).toBe('local_write_file');
    expect(payload.attempted_path).toContain('diary/today.md');
    expect(payload.suggested_exact).toContain('diary/today.md');
    expect(payload.suggested_parent).toContain('diary');
    expect(payload.guard_reason).toBe('Path is outside the allowed directories.');
    expect(payload.iteration).toBe(7);
    expect(typeof payload.timestamp).toBe('string');
  });

  it('resets the agent to idle without bumping failed_tasks', async () => {
    // @ts-expect-error — stub shape is narrower than RuntimeEngine
    await handleTaskFailure.call(stub.engine, {
      error: permErr,
      taskId: 'task-3',
      agentId: 'agent-3',
      workspaceId: 'ws-3',
      taskTitle: '',
      startTime: Date.now() - 5_000,
    });
    const agentUpdate = stub.updates.find(
      (u) => u.table === 'agent_workforce_agents' && u.patch.status === 'idle',
    );
    expect(agentUpdate).toBeDefined();
    expect(agentUpdate!.patch).not.toHaveProperty('stats');
  });

  it('emits task:needs_approval with the permission payload', async () => {
    // @ts-expect-error — stub shape is narrower than RuntimeEngine
    await handleTaskFailure.call(stub.engine, {
      error: permErr,
      taskId: 'task-4',
      agentId: 'agent-4',
      workspaceId: 'ws-4',
      taskTitle: 'Daily diary',
      startTime: Date.now() - 5_000,
    });
    const evt = stub.events.find((e) => e.name === 'task:needs_approval');
    expect(evt).toBeDefined();
    const payload = evt!.payload as Record<string, unknown>;
    expect(payload.taskId).toBe('task-4');
    expect(payload.agentName).toBe('diary-writer');
    const perm = payload.permission as Record<string, unknown>;
    expect(perm.toolName).toBe('local_write_file');
    expect(perm.suggestedParent).toContain('diary');
  });

  it('writes a permission_requested activity row via RPC', async () => {
    // @ts-expect-error — stub shape is narrower than RuntimeEngine
    await handleTaskFailure.call(stub.engine, {
      error: permErr,
      taskId: 'task-5',
      agentId: 'agent-5',
      workspaceId: 'ws-5',
      taskTitle: 'Daily diary',
      startTime: Date.now() - 5_000,
    });
    const rpc = stub.rpcCalls.find((c) => c.name === 'create_agent_activity');
    expect(rpc).toBeDefined();
    expect(rpc!.args.p_activity_type).toBe('permission_requested');
    expect(String(rpc!.args.p_title)).toContain('diary-writer');
    expect(String(rpc!.args.p_title)).toContain('diary/today.md');
  });
});
