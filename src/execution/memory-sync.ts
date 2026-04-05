/**
 * Memory Sync — Memory extraction, dedup, confidentiality, sync payload
 *
 * Extracted from RuntimeEngine to keep the engine as an orchestrating shell.
 * Calls an LLM to extract reusable memories from completed tasks, filters
 * junk, deduplicates against existing memories, classifies confidentiality,
 * and returns sync payloads for potential cloud upload.
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

export const MEMORY_EXTRACTION_PROMPT = `You are a memory extraction system for an AI agent. Analyze a completed task and extract reusable learnings.

Respond with ONLY a JSON array of objects, each with:
- "type": one of "fact", "skill", "feedback_positive", "feedback_negative"
- "content": a concise, actionable memory (1-2 sentences max)

Rules:
- Extract 0-5 memories maximum
- Be specific and actionable, not vague
- "fact" = user preferences, brand details, audience info, business facts
- "skill" = formats, structures, tones, techniques that work well
- "feedback_positive" = patterns that got approved / worked well
- "feedback_negative" = patterns to avoid / that got rejected
- Skip anything too generic or obvious
- If nothing useful, return an empty array []`;

const MODEL_MAP_HAIKU = 'claude-haiku-4-5-20251001';

// ============================================================================
// TYPES
// ============================================================================

export interface ExtractMemoriesOpts {
  agentId: string;
  taskId: string;
  workspaceId: string;
  taskTitle: string;
  taskInput: string;
  taskOutput: string;
  toolsUsed?: string[];
}

export interface ExtractMemoriesDeps {
  db: DatabaseAdapter;
  anthropic: Anthropic | null;
  modelRouter: ModelRouter | null;
  onMemoryExtracted?: (agentId: string, count: number) => void;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export async function extractMemories(
  opts: ExtractMemoriesOpts,
  deps: ExtractMemoriesDeps,
): Promise<MemorySyncPayload[]> {
  const { agentId, taskId, workspaceId, taskTitle, taskInput, taskOutput, toolsUsed } = opts;
  const { db, anthropic, modelRouter, onMemoryExtracted } = deps;

  try {
    const userPrompt = `Task completed: "${taskTitle}"\n\nInput: ${taskInput.slice(0, 500)}\n\nOutput: ${taskOutput.slice(0, 1000)}\n\nExtract reusable learnings from this task.`;

    // Call model for extraction (Ollama when available, Haiku fallback)
    let textContent: string;
    let extractionInputTokens: number;
    let extractionOutputTokens: number;

    if (modelRouter) {
      const provider = await modelRouter.getProvider('memory_extraction');
      const response = await provider.createMessage({
        system: MEMORY_EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 1024,
        temperature: 0,
      });
      textContent = response.content;
      extractionInputTokens = response.inputTokens;
      extractionOutputTokens = response.outputTokens;
    } else if (anthropic) {
      const response = await anthropic.messages.create({
        model: MODEL_MAP_HAIKU,
        max_tokens: 1024,
        temperature: 0,
        system: MEMORY_EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });
      textContent = response.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');
      extractionInputTokens = response.usage.input_tokens;
      extractionOutputTokens = response.usage.output_tokens;
    } else {
      return []; // No model available for memory extraction
    }

    // Parse extracted memories
    let extracted: Array<{ type: string; content: string }> = [];
    try {
      extracted = JSON.parse(textContent);
      if (!Array.isArray(extracted)) extracted = [];
    } catch {
      return []; // Can't parse, skip
    }

    // Save memories (with dedup + junk filtering)
    const validTypes = ['fact', 'skill', 'feedback_positive', 'feedback_negative'];

    // Classify confidentiality based on tools used during the task
    const _confidentiality = classifyMemoryConfidentiality(toolsUsed || []);

    // Fetch existing active memories for dedup check
    const { data: existingData } = await db
      .from<ExistingMemory>('agent_workforce_agent_memory')
      .select('id, content')
      .eq('agent_id', agentId)
      .eq('workspace_id', workspaceId)
      .eq('is_active', 1);
    const existingMemories: ExistingMemory[] = existingData ?? [];

    let insertedCount = 0;
    const insertedMemories: MemorySyncPayload[] = [];
    const now = new Date().toISOString();

    for (const mem of extracted) {
      if (!validTypes.includes(mem.type) || !mem.content) continue;
      if (isJunkMemory(mem.content)) continue;

      const dedup = checkDedup(mem.content, existingMemories);

      if (dedup.action === 'skip') continue;

      if (dedup.action === 'update_existing' && dedup.existingId) {
        // Refresh the existing similar memory instead of creating a duplicate
        await db.from('agent_workforce_agent_memory')
          .update({ updated_at: now })
          .eq('id', dedup.existingId);
        continue;
      }

      // Per-memory confidentiality: bump if PII detected in this specific memory
      const memConfidentiality = classifyMemoryConfidentiality(
        toolsUsed || [],
        mem.content,
      );

      // Insert new memory with trust level and confidentiality
      const tokenCount = Math.ceil(mem.content.length / 4);
      const memoryId = crypto.randomUUID();
      await db.from('agent_workforce_agent_memory').insert({
        id: memoryId,
        agent_id: agentId,
        workspace_id: workspaceId,
        memory_type: mem.type,
        content: mem.content,
        source_task_id: taskId,
        source_type: 'extraction',
        trust_level: 'inferred',
        relevance_score: 0.5,
        token_count: tokenCount,
        is_active: 1,
        confidentiality_level: memConfidentiality,
        source_device_id: null, // Will be set by control plane if connected
        is_local_only: 0,
      });

      // Build sync payload for potential upload
      insertedMemories.push({
        id: memoryId,
        agentId,
        memoryType: mem.type,
        content: mem.content,
        sourceType: 'extraction',
        relevanceScore: 0.5,
        timesUsed: 0,
        tokenCount,
        trustLevel: 'inferred',
        confidentialityLevel: memConfidentiality,
        createdAt: now,
        updatedAt: now,
      });

      // Add to existing set so subsequent memories in this batch also dedup
      existingMemories.push({ id: memoryId, content: mem.content });
      insertedCount++;
    }

    // Log extraction
    const extractionCost = calculateCostCents(
      'claude-haiku-4',
      extractionInputTokens,
      extractionOutputTokens,
    );

    await db.from('agent_workforce_memory_extraction_log').insert({
      workspace_id: workspaceId,
      agent_id: agentId,
      task_id: taskId,
      trigger_type: 'task_completed',
      memories_extracted: insertedCount,
      extraction_tokens_used: extractionInputTokens + extractionOutputTokens,
      extraction_cost_cents: extractionCost,
      raw_extraction: JSON.stringify(extracted),
    });

    if (insertedCount > 0 && onMemoryExtracted) {
      onMemoryExtracted(agentId, insertedCount);
    }

    return insertedMemories;
  } catch (err) {
    logger.error({ err }, '[memory-sync] Memory extraction error');
    return [];
  }
}
