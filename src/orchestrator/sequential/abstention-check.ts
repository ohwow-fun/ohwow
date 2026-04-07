/**
 * Abstention Check (Local Runtime)
 *
 * Lightweight check before executing a Sequential step: should this
 * agent participate? Supports both Anthropic Haiku and Ollama.
 *
 * Returns structured JSON: { participate, reason, confidence }.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ModelRouter, ModelProvider } from '../../execution/model-router.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AbstentionDecision {
  participate: boolean;
  reason: string;
  confidence: number;
}

export interface AbstentionCheckInput {
  agentName: string;
  agentRole: string;
  stepPrompt: string;
  predecessorSummary: string;
  /** Anthropic client for cloud-backed check. */
  anthropic?: Anthropic;
  /** Model router for Ollama path. */
  modelRouter?: ModelRouter | null;
}

// ============================================================================
// PROMPT
// ============================================================================

const ABSTENTION_PROMPT = `You decide whether an AI agent should participate in a task step.

The agent has specific expertise. Predecessors may have already done some work. The agent should participate only if its expertise adds genuine value. Abstaining when you have nothing to add is a sign of intelligence, not laziness.

Respond with ONLY this JSON (no markdown, no explanation):
{"participate": true or false, "reason": "one sentence why", "confidence": 0.0 to 1.0}

Examples:
- Agent: "Content Writer", Task: "Analyze server logs" → {"participate": false, "reason": "Server log analysis is outside my content expertise", "confidence": 0.9}
- Agent: "Data Analyst", Task: "Write a blog post", Predecessors: "Researcher found key data" → {"participate": true, "reason": "I can analyze the data the researcher found and add statistical insights", "confidence": 0.8}
- Agent: "Writer", Task: "Write a blog post", Predecessors: "Writer already wrote a solid draft" → {"participate": false, "reason": "A strong draft already exists and my contribution would be redundant", "confidence": 0.85}`;

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export async function checkAbstention(
  input: AbstentionCheckInput
): Promise<AbstentionDecision> {
  const { agentName, agentRole, stepPrompt, predecessorSummary, anthropic, modelRouter } = input;

  const userMessage = [
    `Agent: "${agentName}" (Role: ${agentRole})`,
    `Task: ${stepPrompt.slice(0, 500)}`,
    predecessorSummary
      ? `Predecessors have produced:\n${predecessorSummary.slice(0, 1000)}`
      : 'No predecessor work yet (this agent goes first).',
  ].join('\n\n');

  try {
    let rawText: string | null = null;

    // Try Ollama first
    if (modelRouter) {
      try {
        const provider: ModelProvider = await modelRouter.getProvider('orchestrator');
        if (provider.name === 'ollama' && provider.createMessage) {
          const response = await provider.createMessage({
            system: ABSTENTION_PROMPT,
            messages: [{ role: 'user', content: userMessage }],
            maxTokens: 150,
            temperature: 0.2,
          });
          rawText = response.content;
        }
      } catch {
        // Fall through to Anthropic
      }
    }

    // Anthropic fallback
    if (!rawText && anthropic) {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: ABSTENTION_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.2,
      });
      const textBlock = response.content.find((b) => b.type === 'text');
      if (textBlock && textBlock.type === 'text') rawText = textBlock.text;
    }

    if (!rawText) return defaultParticipate('No model available for abstention check');

    // Parse — strip think tags for qwen/deepseek
    const cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const jsonStr = cleaned.startsWith('{') ? cleaned : cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    return {
      participate: parsed.participate !== false,
      reason: (parsed.reason as string) ?? 'No reason given',
      confidence: typeof parsed.confidence === 'number'
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.5,
    };
  } catch (err) {
    logger.debug({ err, agentName }, 'Abstention check failed, defaulting to participate');
    return defaultParticipate('Abstention check failed');
  }
}

function defaultParticipate(reason: string): AbstentionDecision {
  return { participate: true, reason, confidence: 0.5 };
}
