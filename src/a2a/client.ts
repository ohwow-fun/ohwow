/**
 * A2A Outbound Client (Local Runtime)
 * Sends tasks to external agent systems via A2A protocol.
 * Uses DatabaseAdapter for logging instead of Supabase admin client.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  A2AAgentCard,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATask,
  A2AMessage,
  DbA2AConnection,
} from './types.js';

const REQUEST_TIMEOUT_MS = 60_000;

// ============================================================================
// Agent Card Discovery
// ============================================================================

export async function fetchAgentCard(agentCardUrl: string): Promise<A2AAgentCard> {
  const response = await fetch(agentCardUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch agent card: ${response.status} ${response.statusText}`);
  }

  const card = (await response.json()) as A2AAgentCard;

  if (!card.name || !card.url || !card.skills) {
    throw new Error('Invalid agent card: missing required fields (name, url, skills)');
  }

  return card;
}

// ============================================================================
// Send Task
// ============================================================================

export async function sendTask(
  connection: DbA2AConnection,
  message: A2AMessage,
  db: DatabaseAdapter,
  metadata?: Record<string, unknown>,
): Promise<{ task: A2ATask; rawResult: unknown }> {
  const taskId = `a2a_out_${crypto.randomUUID()}`;

  const request: A2AJsonRpcRequest = {
    jsonrpc: '2.0',
    id: taskId,
    method: 'message/send',
    params: {
      message,
      ...(metadata ? { metadata } : {}),
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildAuthHeaders(connection),
  };

  try {
    const response = await fetch(connection.endpoint_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`A2A request failed: ${response.status} ${response.statusText}`);
    }

    const rpcResponse = (await response.json()) as A2AJsonRpcResponse;

    if (rpcResponse.error) {
      throw new Error(`A2A error ${rpcResponse.error.code}: ${rpcResponse.error.message}`);
    }

    const task = rpcResponse.result as A2ATask;

    // Extract result summary
    const resultSummary = task.status.message?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
      .slice(0, 500) || '';

    const requestSummary = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
      .slice(0, 500);

    // Log the outbound task
    await db.from('a2a_task_logs').insert({
      workspace_id: connection.workspace_id,
      direction: 'outbound',
      a2a_task_id: task.id,
      method: 'message/send',
      connection_id: connection.id,
      status: mapTaskStatus(task.status.state),
      request_summary: requestSummary,
      result_summary: resultSummary,
      completed_at: task.status.state === 'completed' ? new Date().toISOString() : null,
    });

    return { task, rawResult: rpcResponse.result };
  } catch (error) {
    // Try failover to an alternate connection
    if (isConnectionError(error)) {
      const alternate = await findAlternateConnection(connection, db);
      if (alternate) {
        // Log failover
        await db.from('a2a_task_logs').insert({
          workspace_id: connection.workspace_id,
          direction: 'outbound',
          a2a_task_id: `failover_${taskId}`,
          method: 'message/send',
          connection_id: connection.id,
          status: 'failed',
          request_summary: `Failover from "${connection.name}" to "${alternate.name}"`,
          error_code: 'CONNECTION_FAILOVER',
          error_message: `Connection failed, retrying on alternate connection ${alternate.id}`,
          completed_at: new Date().toISOString(),
        });
        return sendTask(alternate, message, db, metadata);
      }
    }
    throw error;
  }
}

// ============================================================================
// Health Check
// ============================================================================

export async function healthCheck(
  connection: DbA2AConnection,
  db: DatabaseAdapter,
): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();

  try {
    const card = await fetchAgentCard(connection.agent_card_url);
    const latencyMs = Date.now() - start;

    await db
      .from('a2a_connections')
      .update({
        last_health_check_at: new Date().toISOString(),
        last_health_status: 'healthy',
        consecutive_failures: 0,
        agent_card_cache: JSON.stringify(card),
        agent_card_fetched_at: new Date().toISOString(),
        status: 'active',
      })
      .eq('id', connection.id);

    return { healthy: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const newFailures = connection.consecutive_failures + 1;

    await db
      .from('a2a_connections')
      .update({
        last_health_check_at: new Date().toISOString(),
        last_health_status: errorMessage,
        consecutive_failures: newFailures,
        status: newFailures >= 5 ? 'error' : connection.status,
      })
      .eq('id', connection.id);

    return { healthy: false, latencyMs, error: errorMessage };
  }
}

// ============================================================================
// Get Task Status
// ============================================================================

export async function getTaskStatus(
  connection: DbA2AConnection,
  taskId: string,
): Promise<A2ATask> {
  const request: A2AJsonRpcRequest = {
    jsonrpc: '2.0',
    id: `status_${crypto.randomUUID()}`,
    method: 'tasks/get',
    params: { id: taskId },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildAuthHeaders(connection),
  };

  const response = await fetch(connection.endpoint_url, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to get task status: ${response.status}`);
  }

  const rpcResponse = (await response.json()) as A2AJsonRpcResponse;
  if (rpcResponse.error) {
    throw new Error(`A2A error: ${rpcResponse.error.message}`);
  }

  return rpcResponse.result as A2ATask;
}

// ============================================================================
// Helpers
// ============================================================================

function buildAuthHeaders(connection: DbA2AConnection): Record<string, string> {
  const config = typeof connection.auth_config === 'string'
    ? JSON.parse(connection.auth_config) as Record<string, unknown>
    : connection.auth_config;

  switch (connection.auth_type) {
    case 'api_key':
      return { Authorization: `Bearer ${config.api_key || ''}` };
    case 'bearer_token':
      return { Authorization: `Bearer ${config.token || ''}` };
    case 'oauth2':
      return { Authorization: `Bearer ${config.access_token || ''}` };
    default:
      return {};
  }
}

function isConnectionError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('timeout') ||
      msg.includes('a2a request failed: 5')
    );
  }
  return false;
}

async function findAlternateConnection(
  failedConnection: DbA2AConnection,
  db: DatabaseAdapter,
): Promise<DbA2AConnection | null> {
  const { data: alternates } = await db
    .from('a2a_connections')
    .select('*')
    .eq('workspace_id', failedConnection.workspace_id)
    .eq('status', 'active')
    .neq('id', failedConnection.id)
    .order('consecutive_failures', { ascending: true })
    .limit(1);

  if (!alternates || (alternates as unknown[]).length === 0) return null;
  const row = (alternates as unknown[])[0] as Record<string, unknown>;
  return parseConnectionRow(row);
}

/** Parse a raw SQLite row into a typed DbA2AConnection */
export function parseConnectionRow(row: Record<string, unknown>): DbA2AConnection {
  return {
    ...row,
    auth_config: typeof row.auth_config === 'string' ? JSON.parse(row.auth_config) : (row.auth_config || {}),
    agent_card_cache: typeof row.agent_card_cache === 'string' ? JSON.parse(row.agent_card_cache) : (row.agent_card_cache || null),
    allowed_data_types: typeof row.allowed_data_types === 'string' ? JSON.parse(row.allowed_data_types) : (row.allowed_data_types || []),
    store_results: row.store_results === 1 || row.store_results === true,
  } as DbA2AConnection;
}

function mapTaskStatus(
  state: string,
): 'pending' | 'working' | 'completed' | 'failed' | 'cancelled' {
  switch (state) {
    case 'submitted': return 'pending';
    case 'working': return 'working';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'canceled': return 'cancelled';
    default: return 'working';
  }
}
