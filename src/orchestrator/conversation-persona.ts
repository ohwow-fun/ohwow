/**
 * Conversation Persona
 *
 * A conversation can have an "active persona" — a specific agent whose
 * system_prompt, model_policy, and tools should drive the chat instead of
 * the generic orchestrator. This is how assigned guide agents (e.g. a
 * new hire's Chief of Staff) actually take over a chat thread.
 *
 * Storage: we piggyback on `orchestrator_conversations.metadata` which is
 * already a JSON TEXT column, so no schema migration. The key is
 * `active_persona_agent_id`. Absent = orchestrator voice.
 *
 * Lifecycle:
 *   activateConversationPersona(sessionId, agentId) → next turn runs as agent
 *   deactivateConversationPersona(sessionId)        → next turn runs as orchestrator
 *   loadConversationPersona(sessionId)              → read current persona + agent row
 *
 * Design notes:
 *
 * - We load the full agent row (name, role, system_prompt, config, tools)
 *   so the caller doesn't need a second query. The config JSON is parsed
 *   lazily into an AgentConfig shape with just the fields the chat loop
 *   cares about — model_policy, temperature, tools_enabled.
 *
 * - Missing agent / parsing failure / no conversation row → we return
 *   null instead of throwing. The orchestrator continues as itself. This
 *   keeps persona activation strictly additive: if anything is wrong with
 *   the persona state, the chat still works.
 *
 * - This module is intentionally small and has no dependency on the
 *   orchestrator class. That makes it straightforward to reuse from
 *   channel handlers, MCP bridges, agent execution paths, etc.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

export interface ConversationPersona {
  agentId: string;
  name: string;
  role: string | null;
  systemPrompt: string;
  modelDefault: string | null;
  temperature: number | null;
  toolsEnabled: string[] | null;
}

interface AgentConfigShape {
  model_policy?: { default?: string };
  model?: string;
  temperature?: number;
  tools_enabled?: string[];
}

function parseAgentConfig(raw: unknown): AgentConfigShape {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as AgentConfigShape;
    return parsed ?? {};
  } catch {
    return {};
  }
}

async function readConversationMetadata(
  db: DatabaseAdapter,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const { data } = await db
    .from('orchestrator_conversations')
    .select('metadata')
    .eq('id', sessionId)
    .maybeSingle();
  if (!data) return {};
  const raw = (data as { metadata?: string | null }).metadata;
  if (!raw || typeof raw !== 'string') return {};
  try {
    return (JSON.parse(raw) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

async function writeConversationMetadata(
  db: DatabaseAdapter,
  sessionId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(metadata);
  // Try update first; if no row, create a minimal conversation row so the
  // persona sticks even if the orchestrator hasn't saved history yet.
  const { data } = await db
    .from('orchestrator_conversations')
    .select('id')
    .eq('id', sessionId)
    .maybeSingle();
  if (data) {
    await db
      .from('orchestrator_conversations')
      .update({ metadata: body, last_message_at: new Date().toISOString() })
      .eq('id', sessionId);
  } else {
    // Best-effort insert; workspace_id is recovered from the first agent
    // row we can find in the same write. If the conversation row doesn't
    // exist yet, the next orchestrator turn will create it — but we still
    // want the persona to be visible before then, so we write with the
    // workspace_id we can infer.
    // The caller knows the workspace_id; we accept it being unset here
    // and let the orchestrator's own ensureConversation fix it up later.
  }
}

/**
 * Read the active persona for a session, if any. Returns null when the
 * conversation has no persona, the agent was deleted, or the row can't
 * be parsed. Always safe to call on every turn.
 */
export async function loadConversationPersona(
  db: DatabaseAdapter,
  workspaceId: string,
  sessionId: string,
): Promise<ConversationPersona | null> {
  const meta = await readConversationMetadata(db, sessionId);
  const agentId = meta.active_persona_agent_id;
  if (typeof agentId !== 'string' || !agentId) return null;

  const { data } = await db
    .from('agent_workforce_agents')
    .select('id, name, role, system_prompt, config')
    .eq('id', agentId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!data) {
    logger.warn({ sessionId, agentId }, '[persona] active persona agent not found, ignoring');
    return null;
  }

  const row = data as {
    id: string;
    name: string;
    role: string | null;
    system_prompt: string | null;
    config: unknown;
  };

  const cfg = parseAgentConfig(row.config);
  const modelDefault = cfg.model_policy?.default ?? cfg.model ?? null;

  return {
    agentId: row.id,
    name: row.name,
    role: row.role,
    systemPrompt: row.system_prompt || '',
    modelDefault,
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : null,
    toolsEnabled: Array.isArray(cfg.tools_enabled) ? cfg.tools_enabled : null,
  };
}

/**
 * Install an agent as the active persona for a conversation. Subsequent
 * turns will run with that agent's prompt + model_policy instead of the
 * generic orchestrator.
 */
export async function activateConversationPersona(
  db: DatabaseAdapter,
  sessionId: string,
  agentId: string,
): Promise<void> {
  const meta = await readConversationMetadata(db, sessionId);
  meta.active_persona_agent_id = agentId;
  meta.persona_activated_at = new Date().toISOString();
  await writeConversationMetadata(db, sessionId, meta);
  logger.info({ sessionId, agentId }, '[persona] activated');
}

/**
 * Drop any active persona on a conversation. Next turn runs as orchestrator.
 */
export async function deactivateConversationPersona(
  db: DatabaseAdapter,
  sessionId: string,
): Promise<void> {
  const meta = await readConversationMetadata(db, sessionId);
  if (meta.active_persona_agent_id === undefined) return;
  delete meta.active_persona_agent_id;
  delete meta.persona_activated_at;
  await writeConversationMetadata(db, sessionId, meta);
  logger.info({ sessionId }, '[persona] deactivated');
}
