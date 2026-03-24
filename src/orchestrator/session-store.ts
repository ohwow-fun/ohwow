/**
 * Session persistence, turn message building, and memory extraction.
 * All standalone functions with explicit dependency injection.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  TextBlock,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { hostname } from 'os';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { isJunkMemory, checkDedup, type ExistingMemory } from '../lib/memory-utils.js';
import type { ModelRouter } from '../execution/model-router.js';
import { MAX_ACTIVE_MEMORIES, MEMORY_EXTRACTION_PROMPT } from './orchestrator-types.js';
import { logger } from '../lib/logger.js';

/** Truncate a title at a word boundary, up to maxLen characters. */
function truncateTitle(text: string, maxLen = 60): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen).replace(/\s+\S*$/, '');
  return truncated || text.slice(0, maxLen);
}

export interface SessionDeps {
  db: DatabaseAdapter;
  workspaceId: string;
}

export interface MemoryExtractionDeps extends SessionDeps {
  anthropicApiKey: string;
  anthropic: Anthropic;
  modelRouter: ModelRouter | null;
}

// ============================================================================
// HISTORY
// ============================================================================

export async function loadHistory(
  deps: SessionDeps,
  sessionId: string,
): Promise<MessageParam[]> {
  const { data } = await deps.db
    .from('orchestrator_chat_sessions')
    .select('messages')
    .eq('id', sessionId)
    .single();

  if (!data) return [];
  const row = data as { messages: string | MessageParam[] };
  const messages = typeof row.messages === 'string'
    ? JSON.parse(row.messages)
    : row.messages;

  const result = Array.isArray(messages) ? messages : [];
  logger.debug(`[orchestrator] loadHistory: ${sessionId.slice(0, 8)} messages: ${result.length}`);
  return result;
}

export async function saveToSession(
  deps: SessionDeps,
  sessionId: string,
  newMessages: MessageParam[],
  title?: string,
): Promise<void> {
  const existing = await loadHistory(deps, sessionId);
  existing.push(...newMessages);

  const trimmed = existing.length > 40 ? existing.slice(-40) : existing;
  logger.debug(`[orchestrator] saveToSession: ${sessionId.slice(0, 8)} new: ${newMessages.length} total: ${trimmed.length}`);

  const { data: existingSession } = await deps.db
    .from('orchestrator_chat_sessions')
    .select('id')
    .eq('id', sessionId)
    .maybeSingle();

  if (existingSession) {
    const { error: updateError } = await deps.db
      .from('orchestrator_chat_sessions')
      .update({
        messages: JSON.stringify(trimmed),
        message_count: trimmed.length,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sessionId);
    if (updateError) {
      logger.error(`[LocalOrchestrator] Failed to update session: ${updateError.message}`);
    }
  } else {
    const autoTitle = title ? truncateTitle(title) : 'New chat';
    const { error: insertError } = await deps.db
      .from('orchestrator_chat_sessions')
      .insert({
        id: sessionId,
        workspace_id: deps.workspaceId,
        messages: JSON.stringify(trimmed),
        message_count: trimmed.length,
        device_name: hostname(),
        title: autoTitle,
      });
    if (insertError) {
      logger.error(`[LocalOrchestrator] Failed to save session: ${insertError.message}`);
    }
  }
}

export async function renameSession(
  deps: SessionDeps,
  sessionId: string,
  title: string,
): Promise<void> {
  const trimmedTitle = truncateTitle(title);
  const { error } = await deps.db
    .from('orchestrator_chat_sessions')
    .update({
      title: trimmedTitle,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);

  if (error) {
    logger.error(`[LocalOrchestrator] Failed to rename session: ${error.message}`);
  }
}

// ============================================================================
// TURN MESSAGE BUILDERS
// ============================================================================

export function buildAnthropicTurnMessages(
  userMessage: string,
  loopMessages: MessageParam[],
  turnStartIndex: number,
  fullContent: string,
): MessageParam[] {
  const turnMessages: MessageParam[] = [{ role: 'user', content: userMessage }];

  for (let i = turnStartIndex; i < loopMessages.length; i++) {
    const msg = loopMessages[i];

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const withoutReminders = (msg.content as ContentBlockParam[]).filter(
        block => !(block.type === 'text' && 'text' in block &&
          (block as TextBlockParam).text.includes('[Tool results received above.')),
      );
      if (withoutReminders.length > 0) {
        turnMessages.push({ role: 'user', content: withoutReminders });
      }
    } else {
      turnMessages.push(msg);
    }
  }

  if (fullContent) {
    turnMessages.push({ role: 'assistant', content: fullContent });
  }

  return turnMessages;
}

export type OllamaMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export function buildOllamaTurnMessages(
  userMessage: string,
  loopMessages: OllamaMessage[],
  turnStartIndex: number,
  fullContent: string,
): MessageParam[] {
  const turnMessages: MessageParam[] = [{ role: 'user', content: userMessage }];

  for (let i = turnStartIndex; i < loopMessages.length; i++) {
    const msg = loopMessages[i];

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const content: ContentBlockParam[] = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls) {
        let parsedInput: Record<string, unknown> = {};
        try { parsedInput = JSON.parse(tc.function.arguments || '{}'); } catch { /* empty */ }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parsedInput,
        } as ContentBlockParam);
      }
      turnMessages.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      const toolResult: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || '',
        content: msg.content,
      };
      const last = turnMessages[turnMessages.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) &&
          (last.content as ContentBlockParam[]).every(b => b.type === 'tool_result')) {
        (last.content as ContentBlockParam[]).push(toolResult);
      } else {
        turnMessages.push({ role: 'user', content: [toolResult] });
      }
    } else if (msg.role === 'user' && msg.content.includes('[Tool results received above.')) {
      continue;
    }
  }

  if (fullContent) {
    turnMessages.push({ role: 'assistant', content: fullContent });
  }

  return turnMessages;
}

// ============================================================================
// ORCHESTRATOR MEMORY
// ============================================================================

export async function loadOrchestratorMemory(deps: SessionDeps): Promise<string | undefined> {
  const { data } = await deps.db
    .from<{ memory_type: string; content: string }>('orchestrator_memory')
    .select('memory_type, content')
    .eq('workspace_id', deps.workspaceId)
    .eq('is_active', 1)
    .order('created_at', { ascending: false })
    .limit(MAX_ACTIVE_MEMORIES);

  if (!data || data.length === 0) return undefined;

  const memories = data;
  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    (grouped[m.memory_type] ??= []).push(m.content);
  }

  // Display names for memory types
  const typeLabels: Record<string, string> = {
    preference: 'Preferences',
    pattern: 'Patterns',
    context: 'Context',
    correction: 'Corrections',
    episodic: 'Past Experiences',
  };

  const sections = Object.entries(grouped)
    .map(([type, items]) => `**${typeLabels[type] || type}**:\n${items.map((c) => `- ${c}`).join('\n')}`)
    .join('\n\n');

  return sections;
}

export async function extractOrchestratorMemory(
  deps: MemoryExtractionDeps,
  sessionId: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  if (!deps.anthropicApiKey && !deps.modelRouter) return;

  try {
    const userContent = `User said: "${userMessage.slice(0, 500)}"\n\nAssistant replied: "${assistantResponse.slice(0, 1000)}"`;
    let text: string;

    if (deps.modelRouter) {
      const provider = await deps.modelRouter.getProvider('memory_extraction');
      const result = await provider.createMessage({
        system: MEMORY_EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        maxTokens: 512,
        temperature: 0,
      });
      text = result.content;
    } else {
      const result = await deps.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        temperature: 0,
        system: MEMORY_EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });
      text = result.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }

    let memories: Array<{ type: string; content: string }>;
    try {
      memories = JSON.parse(text);
    } catch {
      return;
    }

    if (!Array.isArray(memories) || memories.length === 0) return;

    const validTypes = ['preference', 'pattern', 'context', 'correction', 'episodic'];

    const { data: existingData } = await deps.db
      .from<ExistingMemory>('orchestrator_memory')
      .select('id, content')
      .eq('workspace_id', deps.workspaceId)
      .eq('is_active', 1);
    const existingMemories: ExistingMemory[] = existingData ?? [];

    for (const mem of memories.slice(0, 3)) {
      if (!validTypes.includes(mem.type) || !mem.content) continue;
      if (isJunkMemory(mem.content)) continue;

      const dedup = checkDedup(mem.content, existingMemories);

      if (dedup.action === 'skip') continue;

      if (dedup.action === 'update_existing' && dedup.existingId) {
        await deps.db.from('orchestrator_memory')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', dedup.existingId);
        continue;
      }

      await deps.db.from('orchestrator_memory').insert({
        id: crypto.randomUUID(),
        workspace_id: deps.workspaceId,
        memory_type: mem.type,
        content: mem.content,
        source_session_id: sessionId,
        relevance_score: 0.5,
        is_active: 1,
      });

      existingMemories.push({ id: 'new', content: mem.content });
    }

    const { count } = await deps.db
      .from('orchestrator_memory')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', deps.workspaceId)
      .eq('is_active', 1);

    if (count && count > MAX_ACTIVE_MEMORIES) {
      const { data: oldest } = await deps.db
        .from('orchestrator_memory')
        .select('id')
        .eq('workspace_id', deps.workspaceId)
        .eq('is_active', 1)
        .order('created_at', { ascending: true })
        .limit(count - MAX_ACTIVE_MEMORIES);

      if (oldest) {
        for (const row of oldest as Array<{ id: string }>) {
          await deps.db.from('orchestrator_memory')
            .update({ is_active: 0, updated_at: new Date().toISOString() })
            .eq('id', row.id);
        }
      }
    }
  } catch (err) {
    logger.error(`[LocalOrchestrator] Memory extraction error: ${err}`);
  }
}
