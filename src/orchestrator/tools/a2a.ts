/**
 * A2A orchestrator tools: list_a2a_connections, send_a2a_task, test_a2a_connection
 */

import { sendTask, healthCheck, parseConnectionRow } from '../../a2a/client.js';
import type { A2AMessage } from '../../a2a/types.js';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

export async function listA2AConnections(ctx: LocalToolContext): Promise<ToolResult> {
  const { data: connections, error } = await ctx.db
    .from('a2a_connections')
    .select('id, name, description, endpoint_url, status, trust_level, last_health_check_at, last_health_status, agent_card_cache')
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: `Couldn't list connections: ${error.message}` };

  if (!connections || (connections as unknown[]).length === 0) {
    return {
      success: true,
      data: {
        message: 'No A2A connections found. Press [a] in Settings to manage A2A connections.',
        connections: [],
      },
    };
  }

  const formatted = (connections as Array<Record<string, unknown>>).map((c) => {
    const cardCache = typeof c.agent_card_cache === 'string'
      ? JSON.parse(c.agent_card_cache)
      : c.agent_card_cache;
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      endpoint: c.endpoint_url,
      status: c.status,
      trustLevel: c.trust_level,
      lastHealthCheck: c.last_health_check_at,
      healthStatus: c.last_health_status,
      skills: cardCache?.skills?.map((s: { name: string }) => s.name) || [],
    };
  });

  return { success: true, data: { connections: formatted, count: formatted.length } };
}

export async function sendA2ATask(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const connectionId = input.connection_id as string;
  const messageText = input.message as string;

  if (!connectionId || !messageText) {
    return { success: false, error: 'Missing required fields: connection_id, message' };
  }

  const { data: connection } = await ctx.db
    .from('a2a_connections')
    .select('*')
    .eq('id', connectionId)
    .eq('workspace_id', ctx.workspaceId)
    .eq('status', 'active')
    .single();

  if (!connection) return { success: false, error: 'A2A connection not found or inactive' };
  const conn = parseConnectionRow(connection as Record<string, unknown>);

  if (conn.trust_level === 'read_only') {
    return { success: false, error: 'This connection is read-only and cannot send tasks' };
  }

  const a2aMessage: A2AMessage = {
    role: 'user',
    parts: [{ type: 'text', text: messageText }],
  };

  try {
    const { task } = await sendTask(conn, a2aMessage, ctx.db);

    const resultText = task.status.message?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');

    return {
      success: true,
      data: {
        taskId: task.id,
        status: task.status.state,
        connectionName: conn.name,
        result: resultText || null,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Couldn't send task: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

export async function testA2AConnection(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const connectionId = input.connection_id as string;
  if (!connectionId) return { success: false, error: 'Missing required field: connection_id' };

  const { data: connection } = await ctx.db
    .from('a2a_connections')
    .select('*')
    .eq('id', connectionId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (!connection) return { success: false, error: 'A2A connection not found' };
  const conn = parseConnectionRow(connection as Record<string, unknown>);

  const result = await healthCheck(conn, ctx.db);

  return {
    success: true,
    data: {
      connectionName: conn.name,
      healthy: result.healthy,
      latencyMs: result.latencyMs,
      error: result.error || null,
      status: result.healthy ? 'Connection is healthy' : `Connection failed: ${result.error}`,
    },
  };
}
