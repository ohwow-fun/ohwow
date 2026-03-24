/**
 * Verifier Agent — Local LLM-based output verification
 *
 * Uses Anthropic Haiku (via customer's API key) to pre-review agent
 * output for factual consistency, instruction adherence, and completeness.
 *
 * Mirror of the cloud verifier (src/lib/agents/truth-score/verifier.ts)
 * adapted for the local workspace runtime.
 */

import Anthropic from '@anthropic-ai/sdk';
import { calculateCostCents } from '../execution/ai-types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface VerificationIssue {
  type: 'factual' | 'instruction' | 'completeness';
  detail: string;
}

export interface VerificationResult {
  pass: boolean;
  score: number;
  issues: VerificationIssue[];
  tokensUsed: number;
  costCents: number;
}

export interface ToolCallSummaryLocal {
  name: string;
  success: boolean;
  error?: string;
}

// ============================================================================
// VERIFICATION PROMPT
// ============================================================================

const VERIFIER_SYSTEM_PROMPT = `You are a quality assurance verifier for AI agent outputs. Your job is to assess whether an agent's output meets the task requirements.

Evaluate three dimensions:
1. **Instruction adherence**: Does the output follow what was asked in the task?
2. **Factual consistency**: Is the output consistent with the tool results provided?
3. **Completeness**: Does the output cover all aspects of the request?

Respond with ONLY a JSON object:
{
  "pass": true/false,
  "score": 0.0-1.0,
  "issues": [{"type": "factual"|"instruction"|"completeness", "detail": "..."}]
}

Rules:
- Score 0.8+ = pass, below 0.8 = fail
- Be strict on factual consistency
- Return empty issues array if no problems found
- Maximum 3 issues`;

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Verify an agent's output using Haiku.
 * Returns null if verification is skipped (short output, no API key, T1 tier).
 */
export async function verifyAgentOutputLocal(
  taskInput: string,
  agentOutput: string,
  toolCallSummaries: ToolCallSummaryLocal[],
  options: {
    anthropicApiKey: string;
    tierIsT1?: boolean;
  },
): Promise<VerificationResult | null> {
  // Cost guard: skip short outputs
  if (agentOutput.length < 100) return null;

  // Cost guard: skip T1 tasks
  if (options.tierIsT1) return null;

  const client = new Anthropic({ apiKey: options.anthropicApiKey });

  const toolSummary = toolCallSummaries.length > 0
    ? `\nTool calls made:\n${toolCallSummaries.map((t) =>
        `- ${t.name}: ${t.success ? 'succeeded' : `failed (${t.error || 'unknown error'})`}`
      ).join('\n')}`
    : '\nNo tool calls were made.';

  const userPrompt = `Task instructions: ${taskInput.slice(0, 1000)}

Agent output: ${agentOutput.slice(0, 2000)}
${toolSummary}

Assess this output for instruction adherence, factual consistency, and completeness.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      temperature: 0.1,
      system: VERIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const tokensUsed = inputTokens + outputTokens;
    const costCents = calculateCostCents('claude-haiku-4', inputTokens, outputTokens);

    const textContent = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let raw = textContent.trim();
    const fenceMatch = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)```$/);
    if (fenceMatch) raw = fenceMatch[1].trim();

    const parsed = JSON.parse(raw) as {
      pass?: boolean;
      score?: number;
      issues?: Array<{ type?: string; detail?: string }>;
    };

    const score = typeof parsed.score === 'number'
      ? Math.max(0, Math.min(1, parsed.score))
      : 0.5;

    const issues: VerificationIssue[] = Array.isArray(parsed.issues)
      ? parsed.issues
          .filter(
            (i) =>
              i &&
              typeof i.type === 'string' &&
              typeof i.detail === 'string' &&
              ['factual', 'instruction', 'completeness'].includes(i.type),
          )
          .slice(0, 3)
          .map((i) => ({
            type: i.type as 'factual' | 'instruction' | 'completeness',
            detail: i.detail!,
          }))
      : [];

    return {
      pass: parsed.pass === true || score >= 0.8,
      score,
      issues,
      tokensUsed,
      costCents,
    };
  } catch {
    return null;
  }
}
