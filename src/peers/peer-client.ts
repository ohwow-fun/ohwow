/**
 * Peer Client
 *
 * Communicates with a peered workspace using the full workspace API.
 * Tries base_url (LAN) first, falls back to tunnel_url if unreachable.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';

export interface WorkspacePeer {
  id: string;
  name: string;
  base_url: string;
  tunnel_url: string | null;
  peer_token: string | null;
  our_token: string | null;
  status: 'pending' | 'connected' | 'rejected' | 'error';
  capabilities: Record<string, unknown>;
  last_seen_at: string | null;
  last_health_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export interface PeerHealthResult {
  healthy: boolean;
  latencyMs: number;
  url: string;
  runtimeStatus?: Record<string, unknown>;
  error?: string;
}

export interface PeerDelegateResult {
  taskId: string;
  status: string;
  output?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 10_000;

/**
 * Resolve the best reachable URL for a peer.
 * Tries base_url first (LAN), then tunnel_url.
 */
async function resolveUrl(peer: WorkspacePeer): Promise<string> {
  try {
    const res = await fetch(`${peer.base_url}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return peer.base_url;
  } catch {
    // base_url unreachable, try tunnel
  }

  if (peer.tunnel_url) {
    try {
      const res = await fetch(`${peer.tunnel_url}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return peer.tunnel_url;
    } catch {
      // tunnel also unreachable
    }
  }

  throw new Error(`Peer "${peer.name}" is unreachable at ${peer.base_url}${peer.tunnel_url ? ` and ${peer.tunnel_url}` : ''}`);
}

function peerHeaders(peer: WorkspacePeer): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (peer.peer_token) {
    headers['X-Peer-Token'] = peer.peer_token;
  }
  return headers;
}

/**
 * Health check a peer. Hits /health and /api/runtime/status (both public).
 */
export async function healthCheck(
  peer: WorkspacePeer,
  db: DatabaseAdapter,
): Promise<PeerHealthResult> {
  const start = Date.now();

  try {
    const url = await resolveUrl(peer);
    const latencyMs = Date.now() - start;

    // Also try to get runtime status (public endpoint)
    let runtimeStatus: Record<string, unknown> | undefined;
    try {
      const statusRes = await fetch(`${url}/api/runtime/status`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (statusRes.ok) {
        runtimeStatus = (await statusRes.json()) as Record<string, unknown>;
      }
    } catch {
      // Optional, don't fail health check for this
    }

    await db.from('workspace_peers').update({
      status: 'connected',
      last_health_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      consecutive_failures: 0,
      updated_at: new Date().toISOString(),
    }).eq('id', peer.id);

    return { healthy: true, latencyMs, url, runtimeStatus };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const newFailures = peer.consecutive_failures + 1;

    await db.from('workspace_peers').update({
      last_health_at: new Date().toISOString(),
      consecutive_failures: newFailures,
      status: newFailures >= 5 ? 'error' : peer.status,
      updated_at: new Date().toISOString(),
    }).eq('id', peer.id);

    return { healthy: false, latencyMs, url: peer.base_url, error: errorMessage };
  }
}

/**
 * Delegate a task to a peer's agent.
 */
export async function delegateTask(
  peer: WorkspacePeer,
  agentId: string,
  input: string,
  projectId?: string,
): Promise<PeerDelegateResult> {
  const url = await resolveUrl(peer);

  const body: Record<string, unknown> = {
    agent_id: agentId,
    input,
  };
  if (projectId) body.project_id = projectId;

  const res = await fetch(`${url}/api/tasks`, {
    method: 'POST',
    headers: peerHeaders(peer),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Peer task delegation failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const task = (data.task || data.data || data) as Record<string, unknown>;

  return {
    taskId: task.id as string,
    status: (task.status as string) || 'pending',
    output: task.output as string | undefined,
  };
}

/**
 * List agents available on a peer workspace.
 */
export async function listPeerAgents(
  peer: WorkspacePeer,
): Promise<Array<{ id: string; name: string; role: string; status: string }>> {
  const url = await resolveUrl(peer);

  const res = await fetch(`${url}/api/agents`, {
    headers: peerHeaders(peer),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Couldn't list peer agents: ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return (data.agents || data.data || []) as Array<{ id: string; name: string; role: string; status: string }>;
}

/**
 * Chat with a peer's orchestrator.
 */
export async function chatWithOrchestrator(
  peer: WorkspacePeer,
  message: string,
): Promise<string> {
  const url = await resolveUrl(peer);

  const res = await fetch(`${url}/api/orchestrator/chat`, {
    method: 'POST',
    headers: peerHeaders(peer),
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Peer orchestrator chat failed: ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return (data.response || data.message || JSON.stringify(data)) as string;
}

/**
 * Get recent activity from a peer workspace.
 */
export async function getPeerActivity(
  peer: WorkspacePeer,
  limit = 20,
): Promise<Array<Record<string, unknown>>> {
  const url = await resolveUrl(peer);

  const res = await fetch(`${url}/api/activity?limit=${limit}`, {
    headers: peerHeaders(peer),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Couldn't get peer activity: ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return (data.activity || data.data || []) as Array<Record<string, unknown>>;
}

export interface RelayMessagePayload {
  channel: string;
  chatId: string;
  connectionId?: string;
  sender: string;
  text: string;
}

export interface RelayMessageResult {
  relayed: boolean;
  response?: string;
  error?: string;
}

/**
 * Relay an incoming message to a peer's orchestrator for processing.
 * Used when a worker device receives a messaging channel message but
 * doesn't run the orchestrator itself.
 */
export async function relayMessage(
  peer: WorkspacePeer,
  payload: RelayMessagePayload,
): Promise<RelayMessageResult> {
  const url = await resolveUrl(peer);

  const res = await fetch(`${url}/api/peers/relay-message`, {
    method: 'POST',
    headers: peerHeaders(peer),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { relayed: false, error: `Relay failed: ${res.status} ${text}` };
  }

  const data = (await res.json()) as Record<string, unknown>;
  return {
    relayed: true,
    response: data.response as string | undefined,
  };
}

/**
 * Sync messages from a peer since a given timestamp.
 * Returns WhatsApp and Telegram messages created after `since`.
 */
export async function syncMessages(
  peer: WorkspacePeer,
  since: string,
): Promise<{ whatsapp: Record<string, unknown>[]; telegram: Record<string, unknown>[] }> {
  const url = await resolveUrl(peer);
  const res = await fetch(
    `${url}/api/peers/messages?since=${encodeURIComponent(since)}`,
    {
      headers: peerHeaders(peer),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
  return res.json() as Promise<{ whatsapp: Record<string, unknown>[]; telegram: Record<string, unknown>[] }>;
}

/**
 * Parse a raw database row into a typed WorkspacePeer.
 */
export function parsePeerRow(row: Record<string, unknown>): WorkspacePeer {
  return {
    id: row.id as string,
    name: row.name as string,
    base_url: row.base_url as string,
    tunnel_url: (row.tunnel_url as string) || null,
    peer_token: (row.peer_token as string) || null,
    our_token: (row.our_token as string) || null,
    status: (row.status as WorkspacePeer['status']) || 'pending',
    capabilities: typeof row.capabilities === 'string'
      ? JSON.parse(row.capabilities)
      : (row.capabilities as Record<string, unknown>) || {},
    last_seen_at: (row.last_seen_at as string) || null,
    last_health_at: (row.last_health_at as string) || null,
    consecutive_failures: (row.consecutive_failures as number) || 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}
