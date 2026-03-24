/**
 * Orchestrator Tools — Workspace Peers
 *
 * Tools for the orchestrator to interact with peered workspaces:
 * - list_peers: Show connected workspaces and their agents
 * - delegate_to_peer: Send a task to a peer's agent
 * - ask_peer: Chat with a peer's orchestrator
 */

import type { LocalToolContext } from '../local-tool-types.js';
import type { ToolResult } from '../local-tool-types.js';
import {
  parsePeerRow,
  delegateTask,
  listPeerAgents,
  chatWithOrchestrator,
} from '../../peers/peer-client.js';
import { selectBestPeer } from '../../peers/local-router.js';

/**
 * List all connected peers and optionally their available agents.
 */
export async function listPeers(ctx: LocalToolContext): Promise<ToolResult> {
  const { data, error } = await ctx.db.from('workspace_peers')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };

  const peers = ((data || []) as Array<Record<string, unknown>>).map(parsePeerRow);

  const result = peers.map((p) => {
    // Include device capability data from the raw DB row
    const raw = (data || []).find((d: Record<string, unknown>) => d.id === p.id) as Record<string, unknown> | undefined;
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      baseUrl: p.base_url,
      tunnelUrl: p.tunnel_url,
      lastSeenAt: p.last_seen_at,
      capabilities: p.capabilities,
      // Device hardware info (from enhanced handshake)
      totalMemoryGb: raw?.total_memory_gb ?? null,
      memoryTier: raw?.memory_tier ?? null,
      isAppleSilicon: !!(raw?.is_apple_silicon),
      hasNvidiaGpu: !!(raw?.has_nvidia_gpu),
      gpuName: raw?.gpu_name ?? null,
      localModels: (() => {
        try {
          const m = raw?.local_models;
          if (typeof m === 'string') return JSON.parse(m);
          if (Array.isArray(m)) return m;
          return [];
        } catch { return []; }
      })(),
      deviceRole: raw?.device_role ?? 'hybrid',
    };
  });

  return { success: true, data: result };
}

/**
 * Delegate a task to a peer workspace's agent.
 * Requires: peer_id, agent_id, prompt
 */
export async function delegateToPeer(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  let peerId = input.peer_id as string | undefined;
  const agentId = input.agent_id as string;
  const prompt = input.prompt as string;
  const projectId = input.project_id as string | undefined;

  if (!agentId || !prompt) {
    return { success: false, error: 'agent_id and prompt are required' };
  }

  // Auto-select best peer if no peer_id specified
  if (!peerId) {
    const bestPeer = await selectBestPeer(ctx.db, {});
    if (!bestPeer) {
      return { success: false, error: 'No connected peers available' };
    }
    peerId = bestPeer.peerId;
  }

  const { data: row } = await ctx.db.from('workspace_peers')
    .select('*')
    .eq('id', peerId)
    .eq('status', 'connected')
    .maybeSingle();

  if (!row) return { success: false, error: 'Peer not found or not connected' };

  const peer = parsePeerRow(row as Record<string, unknown>);

  try {
    const result = await delegateTask(peer, agentId, prompt, projectId);
    return {
      success: true,
      data: {
        peerName: peer.name,
        taskId: result.taskId,
        status: result.status,
        output: result.output,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Couldn't delegate to ${peer.name}: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Chat with a peer workspace's orchestrator.
 * Useful for asking questions like "what tasks are running?" or "what files were open?"
 */
export async function askPeer(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const peerId = input.peer_id as string;
  const message = input.message as string;

  if (!peerId || !message) {
    return { success: false, error: 'peer_id and message are required' };
  }

  const { data: row } = await ctx.db.from('workspace_peers')
    .select('*')
    .eq('id', peerId)
    .eq('status', 'connected')
    .maybeSingle();

  if (!row) return { success: false, error: 'Peer not found or not connected' };

  const peer = parsePeerRow(row as Record<string, unknown>);

  try {
    const response = await chatWithOrchestrator(peer, message);
    return {
      success: true,
      data: {
        peerName: peer.name,
        response,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Couldn't reach ${peer.name}'s orchestrator: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Smart delegate: auto-select the best peer based on capabilities,
 * then delegate the task. The orchestrator doesn't need to pick the peer manually.
 */
export async function smartDelegate(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = input.agent_id as string;
  const prompt = input.prompt as string;
  const requiredModel = input.required_model as string | undefined;
  const preferGpu = input.prefer_gpu as boolean | undefined;
  const projectId = input.project_id as string | undefined;

  if (!agentId || !prompt) {
    return { success: false, error: 'agent_id and prompt are required' };
  }

  // Auto-select the best peer
  const bestPeer = await selectBestPeer(ctx.db, {
    requiredModel,
    preferGpu: preferGpu ?? false,
  });

  if (!bestPeer) {
    return { success: false, error: 'No connected peers available for delegation' };
  }

  // Fetch the peer record
  const { data: row } = await ctx.db.from('workspace_peers')
    .select('*')
    .eq('id', bestPeer.peerId)
    .maybeSingle();

  if (!row) return { success: false, error: 'Selected peer not found' };

  const peer = parsePeerRow(row as Record<string, unknown>);

  try {
    const result = await delegateTask(peer, agentId, prompt, projectId);
    return {
      success: true,
      data: {
        peerName: peer.name,
        peerId: peer.id,
        selectionReason: bestPeer.reason,
        taskId: result.taskId,
        status: result.status,
        output: result.output,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Couldn't delegate to ${peer.name}: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * List agents available on a peer workspace.
 */
export async function listPeerAgentsTool(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const peerId = input.peer_id as string;

  if (!peerId) {
    return { success: false, error: 'peer_id is required' };
  }

  const { data: row } = await ctx.db.from('workspace_peers')
    .select('*')
    .eq('id', peerId)
    .eq('status', 'connected')
    .maybeSingle();

  if (!row) return { success: false, error: 'Peer not found or not connected' };

  const peer = parsePeerRow(row as Record<string, unknown>);

  try {
    const agents = await listPeerAgents(peer);
    return {
      success: true,
      data: {
        peerName: peer.name,
        agents,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Couldn't list agents on ${peer.name}: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}
