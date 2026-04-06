/**
 * Conversation Memory Sync — Extract knowledge from conversation history
 *
 * Unlike memory-sync.ts which extracts from task completions, this module
 * extracts from conversation exchanges. It runs on:
 * 1. Session idle (2+ minutes of silence)
 * 2. Message count threshold (every 10 exchanges)
 * 3. On-demand ("remember this")
 *
 * Produces richer memory types than task extraction: decisions, insights,
 * procedures, and corrections alongside facts and skills.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TextBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import crypto from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ModelRouter } from './model-router.js';
import type { MemorySyncPayload } from '../control-plane/types.js';
import {
  isJunkMemory,
  checkDedup,
  classifyMemoryConfidentiality,
  type ExistingMemory,
} from '../lib/memory-utils.js';
import { calculateCostCents } from './ai-types.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

export const CONVERSATION_EXTRACTION_PROMPT = `You are a knowledge extraction system. Analyze this conversation and extract reusable knowledge the user would want to remember.

Respond with ONLY a JSON array of objects, each with:
- "type": one of "fact", "skill", "decision", "insight", "procedure", "correction"
- "content": a concise, actionable statement (1-2 sentences max)
- "confidence": 0.0-1.0 (how certain is this knowledge?)

Type definitions:
- "fact" = something learned about the user, their business, preferences, or domain
- "skill" = a technique, format, or approach that worked well
- "decision" = a choice made during the conversation (what was chosen and why)
- "insight" = a non-obvious realization or connection discovered
- "procedure" = a step-by-step process that was established or refined
- "correction" = something that was wrong and got corrected (what to avoid)

Rules:
- Extract 0-8 items maximum
- Be specific and actionable, not vague generalizations
- Decisions must include both the choice AND the reasoning
- Skip greetings, small talk, and obvious statements
- If nothing worth extracting, return an empty array []`;

const MODEL_MAP_HAIKU = 'claude-haiku-4-5-20251001';

/** Minimum exchanges before extraction triggers */
export const EXTRACTION_THRESHOLD = 10;

/** Minimum idle time (ms) before idle extraction triggers */
export const IDLE_EXTRACTION_MS = 2 * 60 * 1000; // 2 minutes

// ============================================================================
// TYPES
// ============================================================================

export interface ConversationExtractionOpts {
  conversationId: string;
  workspaceId: string;
  /** The conversation messages to extract from */
  messages: Array<{ role: string; content: string }>;
  /** Optional: scope memories to a specific agent */
  agentId?: string;
  /** Tools used during the conversation (for confidentiality classification) */
  toolsUsed?: string[];
}

export interface ConversationExtractionDeps {
  db: DatabaseAdapter;
  anthropic: Anthropic | null;
  modelRouter: ModelRouter | null;
}

interface ExtractedItem {
  type: string;
  content: string;
  confidence?: number;
}

// Memory types valid for conversation extraction
const VALID_TYPES = [
  'fact', 'skill', 'decision', 'insight', 'procedure', 'correction',
];

// Map conversation extraction types to storage types
const TYPE_MAP: Record<string, string> = {
  fact: 'fact',
  skill: 'skill',
  decision: 'fact',          // Decisions stored as facts (they're factual knowledge)
  insight: 'fact',           // Insights stored as facts
  procedure: 'procedure',
  correction: 'corrective',  // Map to existing corrective type
};

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Extract memories from a conversation segment.
 * Returns sync payloads for any memories created.
 */
export async function extractFromConversation(
  opts: ConversationExtractionOpts,
  deps: ConversationExtractionDeps,
): Promise<MemorySyncPayload[]> {
  const { conversationId, workspaceId, messages, agentId, toolsUsed } = opts;
  const { db, anthropic, modelRouter } = deps;

  if (messages.length < 2) return []; // Need at least one exchange

  try {
    // Build conversation text for the prompt
    // Filter out ephemeral device-pinned content that shouldn't be extracted
    const filteredMessages = messages.map(m => ({
      ...m,
      content: m.content.replace(/\[DEVICE-PINNED\].*$/gm, '[device-pinned content redacted]'),
    }));

    const conversationText = filteredMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
      .join('\n\n');

    const userPrompt = `Conversation (${messages.length} messages):\n\n${conversationText.slice(0, 4000)}\n\nExtract reusable knowledge from this conversation.`;

    // Call model
    let textContent: string;
    let inputTokens: number;
    let outputTokens: number;

    if (modelRouter) {
      const provider = await modelRouter.getProvider('memory_extraction');
      const response = await provider.createMessage({
        system: CONVERSATION_EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 1024,
        temperature: 0,
      });
      textContent = response.content;
      inputTokens = response.inputTokens;
      outputTokens = response.outputTokens;
    } else if (anthropic) {
      const response = await anthropic.messages.create({
        model: MODEL_MAP_HAIKU,
        max_tokens: 1024,
        temperature: 0,
        system: CONVERSATION_EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });
      textContent = response.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');
      inputTokens = response.usage.input_tokens;
      outputTokens = response.usage.output_tokens;
    } else {
      return [];
    }

    // Parse
    let extracted: ExtractedItem[] = [];
    try {
      extracted = JSON.parse(textContent);
      if (!Array.isArray(extracted)) extracted = [];
    } catch {
      return [];
    }

    // Fetch existing memories for dedup
    const existingQuery = agentId
      ? db.from<ExistingMemory>('agent_workforce_agent_memory')
          .select('id, content')
          .eq('agent_id', agentId)
          .eq('workspace_id', workspaceId)
          .eq('is_active', 1)
      : db.from<ExistingMemory>('agent_workforce_agent_memory')
          .select('id, content')
          .is('agent_id', null)
          .eq('workspace_id', workspaceId)
          .eq('is_active', 1);

    const { data: existingData } = await existingQuery;
    const existingMemories: ExistingMemory[] = existingData ?? [];

    let insertedCount = 0;
    const insertedMemories: MemorySyncPayload[] = [];
    const now = new Date().toISOString();

    for (const mem of extracted) {
      if (!VALID_TYPES.includes(mem.type) || !mem.content) continue;
      if (isJunkMemory(mem.content)) continue;

      // Skip low-confidence extractions
      if (mem.confidence !== undefined && mem.confidence < 0.3) continue;

      const dedup = checkDedup(mem.content, existingMemories);
      if (dedup.action === 'skip') continue;

      if (dedup.action === 'update_existing' && dedup.existingId) {
        await db.from('agent_workforce_agent_memory')
          .update({ updated_at: now })
          .eq('id', dedup.existingId);
        continue;
      }

      const storageType = TYPE_MAP[mem.type] || 'fact';
      const memConfidentiality = classifyMemoryConfidentiality(
        toolsUsed || [],
        mem.content,
      );

      // Prefix decisions and insights with their type for clarity
      let content = mem.content;
      if (mem.type === 'decision') {
        content = `[Decision] ${mem.content}`;
      } else if (mem.type === 'insight') {
        content = `[Insight] ${mem.content}`;
      }

      const tokenCount = Math.ceil(content.length / 4);
      const memoryId = crypto.randomUUID();

      await db.from('agent_workforce_agent_memory').insert({
        id: memoryId,
        agent_id: agentId ?? null,
        workspace_id: workspaceId,
        memory_type: storageType,
        content,
        source_task_id: null,
        source_type: 'extraction',
        source_conversation_id: conversationId,
        trust_level: 'inferred',
        relevance_score: mem.confidence ?? 0.5,
        token_count: tokenCount,
        is_active: 1,
        confidentiality_level: memConfidentiality,
        source_device_id: null,
        is_local_only: 0,
      });

      insertedMemories.push({
        id: memoryId,
        agentId: agentId ?? 'orchestrator',
        memoryType: storageType,
        content,
        sourceType: 'extraction',
        relevanceScore: mem.confidence ?? 0.5,
        timesUsed: 0,
        tokenCount,
        trustLevel: 'inferred',
        confidentialityLevel: memConfidentiality,
        createdAt: now,
        updatedAt: now,
      });

      existingMemories.push({ id: memoryId, content });
      insertedCount++;
    }

    // Log extraction
    const extractionCost = calculateCostCents(
      'claude-haiku-4',
      inputTokens,
      outputTokens,
    );

    await db.from('agent_workforce_memory_extraction_log').insert({
      workspace_id: workspaceId,
      agent_id: agentId ?? 'orchestrator',
      task_id: null,
      trigger_type: 'conversation_extracted',
      memories_extracted: insertedCount,
      extraction_tokens_used: inputTokens + outputTokens,
      extraction_cost_cents: extractionCost,
      raw_extraction: JSON.stringify(extracted),
    });

    // Mark conversation as extracted
    await db.from('orchestrator_conversations')
      .update({
        last_extracted_at: now,
      })
      .eq('id', conversationId);

    if (insertedCount > 0) {
      logger.info(
        { conversationId: conversationId.slice(0, 8), count: insertedCount },
        '[conversation-memory-sync] Extracted memories from conversation',
      );
    }

    return insertedMemories;
  } catch (err) {
    logger.error({ err }, '[conversation-memory-sync] Extraction error');
    return [];
  }
}

// ============================================================================
// IDLE EXTRACTION SCHEDULER
// ============================================================================

/** Track last message time per conversation for idle detection */
const lastMessageTime = new Map<string, number>();
const extractionTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule extraction after idle period.
 * Call this after every message is persisted.
 */
export function scheduleIdleExtraction(
  conversationId: string,
  opts: Omit<ConversationExtractionOpts, 'messages'>,
  deps: ConversationExtractionDeps,
  getMessages: () => Promise<Array<{ role: string; content: string }>>,
): void {
  lastMessageTime.set(conversationId, Date.now());

  // Clear any existing timer
  const existing = extractionTimers.get(conversationId);
  if (existing) clearTimeout(existing);

  // Set new timer
  const timer = setTimeout(async () => {
    extractionTimers.delete(conversationId);
    lastMessageTime.delete(conversationId);

    try {
      const messages = await getMessages();
      if (messages.length < 4) return; // Not enough to extract from

      await extractFromConversation(
        { ...opts, messages },
        deps,
      );
    } catch (err) {
      logger.warn({ err, conversationId }, '[conversation-memory-sync] Idle extraction failed');
    }
  }, IDLE_EXTRACTION_MS);

  extractionTimers.set(conversationId, timer);
}

/**
 * Cancel all pending extraction timers. Call on shutdown.
 */
export function cancelAllExtractionTimers(): void {
  for (const timer of extractionTimers.values()) {
    clearTimeout(timer);
  }
  extractionTimers.clear();
  lastMessageTime.clear();
}
