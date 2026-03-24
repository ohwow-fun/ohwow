/**
 * State management orchestrator tools (local runtime):
 * get_agent_state, set_agent_state, list_agent_state, delete_agent_state
 */

import { randomUUID } from 'node:crypto';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

interface StateRow {
  id: string;
  key: string;
  value: string;
  value_type: string;
  scope: string;
  scope_id: string | null;
  agent_id: string;
  updated_at: string;
}

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

export async function getAgentState(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = input.agent_id as string;
  const key = input.key as string;
  if (!agentId) return { success: false, error: 'agent_id is required' };
  if (!key) return { success: false, error: 'key is required' };

  const scope = (input.scope as string) || 'agent';
  const scopeId = (input.scope_id as string) || null;

  let query = ctx.db
    .from<StateRow>('agent_workforce_task_state')
    .select('value, value_type')
    .eq('workspace_id', ctx.workspaceId)
    .eq('agent_id', agentId)
    .eq('scope', scope)
    .eq('key', key);

  if (scopeId) {
    query = query.eq('scope_id', scopeId);
  } else {
    query = query.is('scope_id', null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) return { success: false, error: error.message };
  if (!data) return { success: true, data: { key, value: null, exists: false } };

  const row = data as unknown as StateRow;
  return { success: true, data: { key, value: parseStoredValue(row.value, row.value_type), exists: true } };
}

export async function setAgentState(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = input.agent_id as string;
  const key = input.key as string;
  const value = input.value;
  if (!agentId) return { success: false, error: 'agent_id is required' };
  if (!key) return { success: false, error: 'key is required' };
  if (value === undefined) return { success: false, error: 'value is required' };

  const scope = (input.scope as string) || 'agent';
  const scopeId = (input.scope_id as string) || null;
  const { serialized, valueType } = serializeValue(value);
  const now = new Date().toISOString();

  let existsQuery = ctx.db
    .from<StateRow>('agent_workforce_task_state')
    .select('id')
    .eq('workspace_id', ctx.workspaceId)
    .eq('agent_id', agentId)
    .eq('scope', scope)
    .eq('key', key);

  if (scopeId) {
    existsQuery = existsQuery.eq('scope_id', scopeId);
  } else {
    existsQuery = existsQuery.is('scope_id', null);
  }

  const { data: existing } = await existsQuery.maybeSingle();

  if (existing) {
    const row = existing as unknown as StateRow;
    const { error } = await ctx.db
      .from('agent_workforce_task_state')
      .update({ value: serialized, value_type: valueType, updated_at: now })
      .eq('id', row.id);
    if (error) return { success: false, error: error.message };
  } else {
    const { error } = await ctx.db
      .from('agent_workforce_task_state')
      .insert({
        id: randomUUID(),
        workspace_id: ctx.workspaceId,
        agent_id: agentId,
        scope,
        scope_id: scopeId,
        key,
        value: serialized,
        value_type: valueType,
        created_at: now,
        updated_at: now,
      });
    if (error) return { success: false, error: error.message };
  }

  return { success: true, data: { message: `State "${key}" saved for agent.` } };
}

export async function listAgentState(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = input.agent_id as string;
  if (!agentId) return { success: false, error: 'agent_id is required' };

  let query = ctx.db
    .from<StateRow>('agent_workforce_task_state')
    .select('key, value, value_type, scope, scope_id, updated_at')
    .eq('workspace_id', ctx.workspaceId)
    .eq('agent_id', agentId)
    .order('updated_at', { ascending: false })
    .limit(100);

  if (input.scope) query = query.eq('scope', input.scope as string);
  if (input.scope_id) query = query.eq('scope_id', input.scope_id as string);

  const { data, error } = await query;
  if (error) return { success: false, error: error.message };

  const entries = ((data || []) as unknown as StateRow[]).map(row => ({
    key: row.key,
    value: parseStoredValue(row.value, row.value_type),
    scope: row.scope,
    scopeId: row.scope_id,
    updatedAt: row.updated_at,
  }));

  return { success: true, data: entries };
}

export async function deleteAgentState(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = input.agent_id as string;
  const key = input.key as string;
  if (!agentId) return { success: false, error: 'agent_id is required' };
  if (!key) return { success: false, error: 'key is required' };

  const scope = (input.scope as string) || 'agent';
  const scopeId = (input.scope_id as string) || null;

  let query = ctx.db
    .from('agent_workforce_task_state')
    .delete()
    .eq('workspace_id', ctx.workspaceId)
    .eq('agent_id', agentId)
    .eq('scope', scope)
    .eq('key', key);

  if (scopeId) {
    query = query.eq('scope_id', scopeId);
  } else {
    query = query.is('scope_id', null);
  }

  const { error } = await query;
  if (error) return { success: false, error: error.message };

  return { success: true, data: { message: `State "${key}" deleted.` } };
}
