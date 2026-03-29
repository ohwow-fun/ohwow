/**
 * State tool executor logic.
 * Handles get_state, set_state, list_state, delete_state against the task_state table.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

interface StateToolContext {
  db: DatabaseAdapter;
  workspaceId: string;
  agentId: string;
  /** Default scope_id for goal scope (from task.goal_id) */
  defaultGoalId?: string;
  /** Current task ID for audit logging */
  taskId?: string;
}

interface StateToolResult {
  content: string;
  is_error?: boolean;
}

interface StateRow {
  id: string;
  key: string;
  value: string;
  value_type: string;
  scope: string;
  scope_id: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_VALUE_SIZE_BYTES = 65536; // 64KB
const MAX_KEYS_PER_AGENT = 500;
const MAX_KEY_LENGTH = 128;

function parseStoredValue(raw: string, valueType: string): unknown {
  if (valueType === 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function serializeValue(value: unknown): { serialized: string; valueType: string } {
  if (typeof value === 'string') return { serialized: value, valueType: 'string' };
  if (typeof value === 'number') return { serialized: JSON.stringify(value), valueType: 'number' };
  if (typeof value === 'boolean') return { serialized: JSON.stringify(value), valueType: 'boolean' };
  return { serialized: JSON.stringify(value), valueType: 'json' };
}

export async function executeStateTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: StateToolContext,
): Promise<StateToolResult> {
  const scope = (input.scope as string) || 'agent';
  const scopeId = (input.scope_id as string) || (scope === 'goal' ? ctx.defaultGoalId : undefined) || null;

  switch (toolName) {
    case 'get_state':
      return getState(input.key as string, scope, scopeId, ctx);
    case 'set_state':
      return setState(input.key as string, input.value, scope, scopeId, ctx);
    case 'list_state':
      return listState(scope === 'agent' && !input.scope ? undefined : scope, scopeId, ctx);
    case 'delete_state':
      return deleteState(input.key as string, scope, scopeId, ctx);
    case 'update_goal_progress':
      return updateGoalProgress(input.value as number, (input.goal_id as string) || undefined, ctx);
    default:
      return { content: `Unknown state tool: ${toolName}`, is_error: true };
  }
}

async function getState(
  key: string,
  scope: string,
  scopeId: string | null,
  ctx: StateToolContext,
): Promise<StateToolResult> {
  if (!key) return { content: 'Error: key is required', is_error: true };

  try {
    let query = ctx.db
      .from<StateRow>('agent_workforce_task_state')
      .select('value, value_type')
      .eq('workspace_id', ctx.workspaceId)
      .eq('agent_id', ctx.agentId)
      .eq('scope', scope)
      .eq('key', key);

    if (scopeId) {
      query = query.eq('scope_id', scopeId);
    } else {
      query = query.is('scope_id', null);
    }

    const { data, error } = await query.maybeSingle();
    if (error) return { content: `Error reading state: ${error.message}`, is_error: true };
    if (!data) return { content: JSON.stringify({ key, value: null, exists: false }) };

    const row = data as unknown as StateRow;
    const value = parseStoredValue(row.value, row.value_type);
    return { content: JSON.stringify({ key, value, exists: true }) };
  } catch (err) {
    logger.error({ err }, '[State] get_state failed');
    return { content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
  }
}

async function setState(
  key: string,
  value: unknown,
  scope: string,
  scopeId: string | null,
  ctx: StateToolContext,
): Promise<StateToolResult> {
  if (!key) return { content: 'Error: key is required', is_error: true };
  if (value === undefined) return { content: 'Error: value is required', is_error: true };
  if (key.length > MAX_KEY_LENGTH) return { content: `Error: key exceeds maximum length of ${MAX_KEY_LENGTH} characters`, is_error: true };

  const { serialized, valueType } = serializeValue(value);

  if (serialized.length > MAX_VALUE_SIZE_BYTES) {
    return { content: `Error: value exceeds maximum size of ${MAX_VALUE_SIZE_BYTES} bytes (got ${serialized.length})`, is_error: true };
  }

  const now = new Date().toISOString();

  try {
    // Check if key exists (include value for audit log)
    let existsQuery = ctx.db
      .from<StateRow>('agent_workforce_task_state')
      .select('id, value')
      .eq('workspace_id', ctx.workspaceId)
      .eq('agent_id', ctx.agentId)
      .eq('scope', scope)
      .eq('key', key);

    if (scopeId) {
      existsQuery = existsQuery.eq('scope_id', scopeId);
    } else {
      existsQuery = existsQuery.is('scope_id', null);
    }

    const { data: existing } = await existsQuery.maybeSingle();

    if (existing) {
      // Update
      const row = existing as unknown as StateRow;
      const oldValue = row.value;
      await ctx.db
        .from('agent_workforce_task_state')
        .update({ value: serialized, value_type: valueType, updated_at: now })
        .eq('id', row.id);

      // Audit log (best-effort)
      try {
        await ctx.db.from('agent_workforce_state_changelog').insert({
          id: randomUUID(),
          workspace_id: ctx.workspaceId,
          agent_id: ctx.agentId,
          task_id: ctx.taskId || null,
          key,
          old_value: oldValue,
          new_value: serialized,
          operation: 'set',
          scope,
          scope_id: scopeId,
          created_at: now,
        });
      } catch { /* non-fatal */ }
    } else {
      // Check key count limit before inserting
      const { data: countData } = await ctx.db
        .from('agent_workforce_task_state')
        .select('id')
        .eq('workspace_id', ctx.workspaceId)
        .eq('agent_id', ctx.agentId);
      const existingCount = countData ? (countData as unknown[]).length : 0;
      if (existingCount >= MAX_KEYS_PER_AGENT) {
        return { content: `Error: agent has reached the maximum of ${MAX_KEYS_PER_AGENT} state keys`, is_error: true };
      }

      // Insert
      await ctx.db
        .from('agent_workforce_task_state')
        .insert({
          id: randomUUID(),
          workspace_id: ctx.workspaceId,
          agent_id: ctx.agentId,
          scope,
          scope_id: scopeId,
          key,
          value: serialized,
          value_type: valueType,
          created_at: now,
          updated_at: now,
        });

      // Audit log (best-effort)
      try {
        await ctx.db.from('agent_workforce_state_changelog').insert({
          id: randomUUID(),
          workspace_id: ctx.workspaceId,
          agent_id: ctx.agentId,
          task_id: ctx.taskId || null,
          key,
          old_value: null,
          new_value: serialized,
          operation: 'set',
          scope,
          scope_id: scopeId,
          created_at: now,
        });
      } catch { /* non-fatal */ }
    }

    return { content: JSON.stringify({ key, value, saved: true }) };
  } catch (err) {
    logger.error({ err }, '[State] set_state failed');
    return { content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
  }
}

async function listState(
  scope: string | undefined,
  scopeId: string | null,
  ctx: StateToolContext,
): Promise<StateToolResult> {
  try {
    let query = ctx.db
      .from<StateRow>('agent_workforce_task_state')
      .select('key, value, value_type, scope, scope_id, updated_at')
      .eq('workspace_id', ctx.workspaceId)
      .eq('agent_id', ctx.agentId)
      .order('updated_at', { ascending: false })
      .limit(100);

    if (scope) query = query.eq('scope', scope);
    if (scopeId) query = query.eq('scope_id', scopeId);

    const { data, error } = await query;
    if (error) return { content: `Error listing state: ${error.message}`, is_error: true };

    const entries = ((data || []) as unknown as StateRow[]).map(row => ({
      key: row.key,
      value: parseStoredValue(row.value, row.value_type),
      scope: row.scope,
      scopeId: row.scope_id,
      updatedAt: row.updated_at,
    }));

    return { content: JSON.stringify({ entries, count: entries.length }) };
  } catch (err) {
    logger.error({ err }, '[State] list_state failed');
    return { content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
  }
}

async function deleteState(
  key: string,
  scope: string,
  scopeId: string | null,
  ctx: StateToolContext,
): Promise<StateToolResult> {
  if (!key) return { content: 'Error: key is required', is_error: true };

  try {
    // Read old value for audit log before deleting
    let oldValue: string | null = null;
    try {
      let readQuery = ctx.db
        .from<StateRow>('agent_workforce_task_state')
        .select('value')
        .eq('workspace_id', ctx.workspaceId)
        .eq('agent_id', ctx.agentId)
        .eq('scope', scope)
        .eq('key', key);
      if (scopeId) readQuery = readQuery.eq('scope_id', scopeId);
      else readQuery = readQuery.is('scope_id', null);
      const { data: oldData } = await readQuery.maybeSingle();
      if (oldData) oldValue = (oldData as unknown as StateRow).value;
    } catch { /* non-fatal */ }

    let query = ctx.db
      .from('agent_workforce_task_state')
      .delete()
      .eq('workspace_id', ctx.workspaceId)
      .eq('agent_id', ctx.agentId)
      .eq('scope', scope)
      .eq('key', key);

    if (scopeId) {
      query = query.eq('scope_id', scopeId);
    } else {
      query = query.is('scope_id', null);
    }

    const { error } = await query;
    if (error) return { content: `Error deleting state: ${error.message}`, is_error: true };

    // Audit log (best-effort)
    try {
      await ctx.db.from('agent_workforce_state_changelog').insert({
        id: randomUUID(),
        workspace_id: ctx.workspaceId,
        agent_id: ctx.agentId,
        task_id: ctx.taskId || null,
        key,
        old_value: oldValue,
        new_value: null,
        operation: 'delete',
        scope,
        scope_id: scopeId,
        created_at: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }

    return { content: JSON.stringify({ key, deleted: true }) };
  } catch (err) {
    logger.error({ err }, '[State] delete_state failed');
    return { content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
  }
}

async function updateGoalProgress(
  value: number,
  goalId: string | undefined,
  ctx: StateToolContext,
): Promise<StateToolResult> {
  const targetGoalId = goalId || ctx.defaultGoalId;
  if (!targetGoalId) return { content: 'Error: no goal_id provided and no goal linked to current task', is_error: true };
  if (!Number.isInteger(value) || value < 0) return { content: 'Error: value must be a non-negative integer', is_error: true };

  try {
    const { data: goalData } = await ctx.db
      .from('agent_workforce_goals')
      .select('current_value, target_value, status')
      .eq('id', targetGoalId)
      .single();

    if (!goalData) return { content: `Error: goal not found: ${targetGoalId}`, is_error: true };

    const goal = goalData as { current_value: number | null; target_value: number | null; status: string };
    const previousValue = goal.current_value ?? 0;

    const updateData: Record<string, unknown> = {
      current_value: value,
      updated_at: new Date().toISOString(),
    };

    // Auto-complete goal if target reached
    const completed = goal.target_value !== null && value >= goal.target_value && goal.status === 'active';
    if (completed) {
      updateData.status = 'completed';
      updateData.completed_at = new Date().toISOString();
    }

    await ctx.db
      .from('agent_workforce_goals')
      .update(updateData)
      .eq('id', targetGoalId);

    return {
      content: JSON.stringify({
        goalId: targetGoalId,
        previousValue,
        newValue: value,
        completed,
      }),
    };
  } catch (err) {
    logger.error({ err }, '[State] update_goal_progress failed');
    return { content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
  }
}

/**
 * Load context from the most recent completed task for this agent.
 * Returns the last few assistant messages as a markdown section to provide
 * cross-task continuity in the system prompt.
 */
export async function loadPreviousTaskContext(
  db: DatabaseAdapter,
  workspaceId: string,
  agentId: string,
  currentTaskId: string,
): Promise<string | null> {
  // Find most recent completed task for this agent (not the current one)
  const { data: prevTaskData } = await db
    .from('agent_workforce_tasks')
    .select('id, title')
    .eq('agent_id', agentId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(2);

  const prevTasks = (prevTaskData || []) as Array<{ id: string; title: string }>;
  const prevTask = prevTasks.find(t => t.id !== currentTaskId);
  if (!prevTask) return null;

  // Load last 5 assistant messages from that task
  const { data: msgData } = await db
    .from('agent_workforce_task_messages')
    .select('content, role')
    .eq('task_id', prevTask.id)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(5);

  if (!msgData || (msgData as unknown[]).length === 0) return null;

  const msgs = (msgData as Array<{ content: string; role: string }>).reverse();
  let combined = msgs.map(m => m.content).join('\n\n');

  // Cap at 8000 chars (~2000 tokens)
  if (combined.length > 8000) {
    combined = combined.slice(0, 8000) + '...';
  }

  return `## Previous Task Context\nFrom task "${prevTask.title}":\n\n${combined}`;
}

/**
 * Load all state entries for an agent and format as a context document
 * to inject into the system prompt before task execution.
 */
export async function loadStateContext(
  db: DatabaseAdapter,
  workspaceId: string,
  agentId: string,
  goalId?: string,
): Promise<string | null> {
  try {
    const { data } = await db
      .from<StateRow>('agent_workforce_task_state')
      .select('key, value, value_type, scope, scope_id, updated_at')
      .eq('workspace_id', workspaceId)
      .eq('agent_id', agentId)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (!data || (data as unknown as StateRow[]).length === 0) return null;

    const entries = (data as unknown as StateRow[]);

    // Separate agent-scoped vs goal-scoped entries
    const agentEntries = entries.filter(e => e.scope === 'agent');
    const goalEntries = goalId ? entries.filter(e => e.scope === 'goal' && e.scope_id === goalId) : [];
    const scheduleEntries = entries.filter(e => e.scope === 'schedule');

    const lines: string[] = ['## Persistent State (from previous runs)'];
    lines.push('Use get_state/set_state tools to read and update these values.\n');

    if (agentEntries.length > 0) {
      for (const e of agentEntries) {
        const val = parseStoredValue(e.value, e.value_type);
        const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
        lines.push(`- **${e.key}**: ${display}`);
      }
    }

    if (goalEntries.length > 0) {
      lines.push('\n### Goal State');
      for (const e of goalEntries) {
        const val = parseStoredValue(e.value, e.value_type);
        const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
        lines.push(`- **${e.key}**: ${display}`);
      }
    }

    if (scheduleEntries.length > 0) {
      lines.push('\n### Schedule State');
      for (const e of scheduleEntries) {
        const val = parseStoredValue(e.value, e.value_type);
        const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
        lines.push(`- **${e.key}** (schedule ${e.scope_id}): ${display}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    logger.warn({ err }, '[State] Failed to load state context');
    return null;
  }
}
