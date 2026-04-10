/**
 * Conversation Digest — LLM-distilled structured summaries of conversation segments.
 *
 * When the context window fills up and older messages need compression,
 * this module produces semantic digests that preserve decisions, facts,
 * goals, and tool outcomes — not lossy 100-char truncations.
 *
 * Part of the tiered context system:
 *   HOT (recent full messages) → WARM (digests) → COLD (memories)
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ModelRouter } from '../execution/model-router.js';
import { logger } from '../lib/logger.js';
import { randomUUID } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

export interface ConversationDigest {
  decisions: Array<{ what: string; why: string }>;
  facts: string[];
  goals: Array<{ text: string; status: 'active' | 'achieved' | 'blocked' }>;
  toolOutcomes: Array<{ tool: string; action: string; result: string }>;
  openQuestions: string[];
  summary: string;
}

export interface DigestDeps {
  db: DatabaseAdapter;
  workspaceId: string;
  modelRouter: ModelRouter | null;
}

// ============================================================================
// EXTRACTION PROMPT
// ============================================================================

const DIGEST_PROMPT = `You are a conversation context distiller. Given a segment of conversation messages, extract a structured digest that preserves all important information.

Return ONLY valid JSON with this structure:
{
  "decisions": [{"what": "...", "why": "..."}],
  "facts": ["fact1", "fact2"],
  "goals": [{"text": "...", "status": "active|achieved|blocked"}],
  "toolOutcomes": [{"tool": "tool_name", "action": "what was done", "result": "outcome"}],
  "openQuestions": ["question1"],
  "summary": "2-3 sentence narrative summary of this segment"
}

Rules:
- Extract ALL decisions with their reasoning (the "why" prevents hallucination later)
- Facts include business info, user preferences, agreed-upon constraints
- Goals are objectives the user expressed or implied
- Tool outcomes summarize what tools did and whether they succeeded
- Open questions are unresolved items that need follow-up
- Keep the summary concise but complete`;

// ============================================================================
// DISTILL SEGMENT
// ============================================================================

/**
 * Distill a conversation segment into a structured digest.
 * Uses the cheapest available model (fire-and-forget pattern).
 */
export async function distillSegment(
  deps: DigestDeps,
  conversationId: string,
  messages: Array<{ role: string; content: string | unknown[] }>,
  segmentRange: [number, number],
): Promise<ConversationDigest | null> {
  if (!deps.modelRouter || messages.length === 0) return null;

  try {
    // Format messages for the extraction prompt
    const formattedMessages = messages.map((m, i) => {
      const content = typeof m.content === 'string'
        ? m.content.slice(0, 500)
        : JSON.stringify(m.content).slice(0, 500);
      return `[${m.role}]: ${content}`;
    }).join('\n\n');

    const provider = await deps.modelRouter.getProvider('memory_extraction');
    if (!provider?.createMessage) return null;

    const response = await provider.createMessage({
      system: DIGEST_PROMPT,
      messages: [{ role: 'user', content: formattedMessages }],
      maxTokens: 600,
      temperature: 0,
    });

    // Parse the JSON response
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const digest = JSON.parse(jsonMatch[0]) as ConversationDigest;

    // Store in database
    await deps.db.from('orchestrator_conversation_digests').insert({
      id: randomUUID(),
      conversation_id: conversationId,
      workspace_id: deps.workspaceId,
      segment_start_idx: segmentRange[0],
      segment_end_idx: segmentRange[1],
      digest: JSON.stringify(digest),
      token_count: response.inputTokens + response.outputTokens,
    });

    logger.debug(
      { conversationId, range: segmentRange, decisions: digest.decisions.length, facts: digest.facts.length },
      '[digest] Segment distilled',
    );

    return digest;
  } catch (err) {
    logger.debug({ err }, '[digest] Segment distillation failed (non-fatal)');
    return null;
  }
}

// ============================================================================
// LOAD DIGESTS
// ============================================================================

/**
 * Load all digests for a conversation, ordered by segment position.
 */
export async function loadDigests(
  deps: DigestDeps,
  conversationId: string,
): Promise<ConversationDigest[]> {
  try {
    const { data } = await deps.db
      .from('orchestrator_conversation_digests')
      .select('digest')
      .eq('conversation_id', conversationId)
      .order('segment_start_idx', { ascending: true });

    if (!data) return [];
    return data.map((row) => {
      const raw = (row as { digest: string }).digest;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    });
  } catch {
    return [];
  }
}

// ============================================================================
// FORMAT FOR CONTEXT INJECTION
// ============================================================================

/**
 * Format digests as a context message for injection into the conversation.
 */
export function formatDigestsForContext(digests: ConversationDigest[]): string {
  if (digests.length === 0) return '';

  const sections: string[] = ['[Context from earlier conversation segments]'];

  const allDecisions = digests.flatMap(d => d.decisions);
  const allFacts = digests.flatMap(d => d.facts);
  const allGoals = digests.flatMap(d => d.goals);
  const allOpenQuestions = digests.flatMap(d => d.openQuestions);

  if (allDecisions.length > 0) {
    sections.push('Decisions made:');
    for (const d of allDecisions.slice(0, 10)) {
      sections.push(`- ${d.what} (because: ${d.why})`);
    }
  }

  if (allFacts.length > 0) {
    sections.push('Established facts:');
    for (const f of allFacts.slice(0, 10)) {
      sections.push(`- ${f}`);
    }
  }

  if (allGoals.length > 0) {
    sections.push('Goals:');
    for (const g of allGoals.slice(0, 5)) {
      sections.push(`- [${g.status}] ${g.text}`);
    }
  }

  if (allOpenQuestions.length > 0) {
    sections.push('Open questions:');
    for (const q of allOpenQuestions.slice(0, 5)) {
      sections.push(`- ${q}`);
    }
  }

  return sections.join('\n');
}
