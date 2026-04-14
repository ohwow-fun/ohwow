/**
 * State management orchestrator tools (local runtime):
 * get_agent_state, set_agent_state, list_agent_state, delete_agent_state,
 * clear_agent_state.
 *
 * TTL semantics:
 *   - Persistent state (no expires_at) is the default for keys the orchestrator
 *     wants to remember across runs (counters, progress, etc.).
 *   - Ephemeral state — keys matching incident_*, *_health_*, temp_*, scratch_* —
 *     defaults to a 24h expiry so an agent that wrote a flag during an old
 *     incident can't poison reasoning forever. Callers can override either
 *     direction by passing ttl_seconds (positive = expiry, 0/null = persistent).
 *   - Reads filter expired rows in app code and lazy-delete them so the next
 *     reader doesn't trip the same row.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { randomUUID } from 'node:crypto';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

export const AGENT_STATE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'get_agent_state',
    description:
      'Read a persistent state value for an agent. State persists across task runs, enabling agents to track counters, progress, or structured data over time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent whose state to read' },
        key: { type: 'string', description: 'The state key to retrieve' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'State scope. Default: "agent"' },
        scope_id: { type: 'string', description: 'Scope ID (goal or schedule ID) when scope is not "agent"' },
      },
      required: ['agent_id', 'key'],
    },
  },
  {
    name: 'set_agent_state',
    description:
      'Save a persistent state value for an agent. The value will be available in future task runs. Use for counters, progress tracking, structured data, etc. ' +
      'Pass ttl_seconds to expire the value automatically (e.g. 3600 for one hour). Keys matching incident_*, *_health_*, temp_*, scratch_* expire after 24h by default.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent whose state to update' },
        key: { type: 'string', description: 'The state key to store' },
        value: { description: 'The value to store (string, number, boolean, array, or object)' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'State scope. Default: "agent"' },
        scope_id: { type: 'string', description: 'Scope ID (goal or schedule ID) when scope is not "agent"' },
        ttl_seconds: { type: 'number', description: 'Optional expiry. Positive integer = expire after N seconds. 0 or negative = persistent (no expiry). Omit to use the key-shape default.' },
      },
      required: ['agent_id', 'key', 'value'],
    },
  },
  {
    name: 'list_agent_state',
    description:
      'List all persistent state keys and values for an agent. Shows what data the agent has stored across task runs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent whose state to list' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'Filter by scope' },
        scope_id: { type: 'string', description: 'Filter by scope ID' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'delete_agent_state',
    description:
      'Delete a persistent state key for an agent.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent whose state to modify' },
        key: { type: 'string', description: 'The state key to delete' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'State scope. Default: "agent"' },
        scope_id: { type: 'string', description: 'Scope ID (goal or schedule ID) when scope is not "agent"' },
      },
      required: ['agent_id', 'key'],
    },
  },
  {
    name: 'clear_agent_state',
    description:
      'Bulk-delete state rows by key prefix. Use to purge polluted or stale state ' +
      '(e.g. clear every incident_* row when an incident is resolved). If agent_id is ' +
      'omitted, clears across every agent in the workspace. key_prefix is required to ' +
      'prevent accidental "delete everything."',
    input_schema: {
      type: 'object' as const,
      properties: {
        key_prefix: { type: 'string', description: 'Required. Match keys starting with this prefix.' },
        agent_id: { type: 'string', description: 'Optional. Limit purge to one agent. Omit for workspace-wide.' },
        scope: { type: 'string', enum: ['agent', 'goal', 'schedule'], description: 'Optional scope filter.' },
        scope_id: { type: 'string', description: 'Optional scope ID filter.' },
      },
      required: ['key_prefix'],
    },
  },
];

interface StateRow {
  id: string;
  key: string;
  value: string;
  value_type: string;
  scope: string;
  scope_id: string | null;
  agent_id: string;
  updated_at: string;
  expires_at: string | null;
}

const EPHEMERAL_KEY_PATTERNS: RegExp[] = [
  /^incident_/i,
  /_health_/i,
  /^temp_/i,
  /^scratch_/i,
];

const DEFAULT_EPHEMERAL_TTL_SECONDS = 24 * 60 * 60;

/** Decide a default expiry for a write based on the key shape. */
function defaultTtlSeconds(key: string): number | null {
  for (const pattern of EPHEMERAL_KEY_PATTERNS) {
    if (pattern.test(key)) return DEFAULT_EPHEMERAL_TTL_SECONDS;
  }
  return null;
}

/** ISO timestamp in the same format `Date.toISOString()` produces, N seconds from now. */
function isoFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function isExpired(row: { expires_at: string | null }): boolean {
  return !!row.expires_at && row.expires_at < nowIso();
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
    .select('id, value, value_type, expires_at')
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
  if (isExpired(row)) {
    // Lazy cleanup: delete the expired row so the next caller doesn't pay the
    // round-trip again, then report it as missing.
    await ctx.db
      .from('agent_workforce_task_state')
      .delete()
      .eq('id', row.id);
    return { success: true, data: { key, value: null, exists: false } };
  }

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
  const now = nowIso();

  // ttl_seconds resolution:
  //   number > 0  → explicit expiry from caller
  //   number <= 0 → explicit persistent (no expiry)
  //   undefined   → fall back to key-based heuristic
  let ttlSeconds: number | null;
  const rawTtl = input.ttl_seconds;
  if (typeof rawTtl === 'number') {
    ttlSeconds = rawTtl > 0 ? rawTtl : null;
  } else {
    ttlSeconds = defaultTtlSeconds(key);
  }
  const expiresAt = ttlSeconds ? isoFromNow(ttlSeconds) : null;

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
      .update({ value: serialized, value_type: valueType, updated_at: now, expires_at: expiresAt })
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
        expires_at: expiresAt,
      });
    if (error) return { success: false, error: error.message };
  }

  return {
    success: true,
    data: {
      message: `State "${key}" saved for agent.`,
      expires_at: expiresAt,
    },
  };
}

export async function listAgentState(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = input.agent_id as string;
  if (!agentId) return { success: false, error: 'agent_id is required' };

  let query = ctx.db
    .from<StateRow>('agent_workforce_task_state')
    .select('id, key, value, value_type, scope, scope_id, updated_at, expires_at')
    .eq('workspace_id', ctx.workspaceId)
    .eq('agent_id', agentId)
    .order('updated_at', { ascending: false })
    .limit(100);

  if (input.scope) query = query.eq('scope', input.scope as string);
  if (input.scope_id) query = query.eq('scope_id', input.scope_id as string);

  const { data, error } = await query;
  if (error) return { success: false, error: error.message };

  const rows = (data || []) as unknown as StateRow[];
  const expiredIds: string[] = [];
  const live: StateRow[] = [];
  for (const row of rows) {
    if (isExpired(row)) expiredIds.push(row.id);
    else live.push(row);
  }

  // Lazy-delete expired rows surfaced by the list call.
  if (expiredIds.length > 0) {
    await ctx.db
      .from('agent_workforce_task_state')
      .delete()
      .in('id', expiredIds);
  }

  const entries = live.map(row => ({
    key: row.key,
    value: parseStoredValue(row.value, row.value_type),
    scope: row.scope,
    scopeId: row.scope_id,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
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

/**
 * Bulk purge by key prefix. Used to clear pollution like "drop every
 * incident_* row for this agent" without listing + deleting one at a time.
 *
 * If agent_id is omitted, purges across every agent in the workspace —
 * useful for the orchestrator to clear workspace-wide flags. If key_prefix
 * is omitted, the call is rejected to prevent accidental "clear everything."
 */
export async function clearAgentState(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const keyPrefix = input.key_prefix as string;
  if (!keyPrefix || typeof keyPrefix !== 'string') {
    return { success: false, error: 'key_prefix is required and must be a non-empty string' };
  }

  const agentId = (input.agent_id as string) || null;
  const scope = (input.scope as string) || null;
  const scopeId = (input.scope_id as string) || null;

  // Find matching rows first so we can report a count and respect the
  // SQL-level filters via the same query builder.
  let findQuery = ctx.db
    .from<StateRow>('agent_workforce_task_state')
    .select('id')
    .eq('workspace_id', ctx.workspaceId);

  if (agentId) findQuery = findQuery.eq('agent_id', agentId);
  if (scope) findQuery = findQuery.eq('scope', scope);
  if (scopeId) findQuery = findQuery.eq('scope_id', scopeId);

  // Use a `like` filter for prefix match. The adapter exposes this via
  // .or() with a single filter expression — it's the only way to express
  // LIKE against the Supabase-style builder without adding a new method.
  findQuery = findQuery.or(`key.like.${keyPrefix}%`);

  const { data: matches, error: findError } = await findQuery;
  if (findError) return { success: false, error: findError.message };

  const ids = ((matches || []) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length === 0) {
    return { success: true, data: { cleared: 0, key_prefix: keyPrefix } };
  }

  const { error: deleteError } = await ctx.db
    .from('agent_workforce_task_state')
    .delete()
    .in('id', ids);

  if (deleteError) return { success: false, error: deleteError.message };

  return {
    success: true,
    data: {
      cleared: ids.length,
      key_prefix: keyPrefix,
      message: `Cleared ${ids.length} state ${ids.length === 1 ? 'row' : 'rows'} matching "${keyPrefix}*".`,
    },
  };
}
