/**
 * Sequence Decomposer (Local Runtime)
 *
 * Takes a user prompt and available agents, calls a fast model
 * to produce a SequenceDefinition. Supports both Anthropic (Haiku)
 * and Ollama as providers.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ModelRouter, ModelProvider } from '../../execution/model-router.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { SequenceDefinition, SequenceStep } from './types.js';
import { createEphemeralAgent } from './agent-factory.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DecomposeInput {
  prompt: string;
  agents: Array<{
    id: string;
    name: string;
    role: string;
  }>;
  /** Anthropic client (for cloud-backed decomposition). */
  anthropic?: Anthropic;
  /** Model router for Ollama path. */
  modelRouter?: ModelRouter | null;
  /** Ollama model name to use for decomposition. */
  ollamaModel?: string;
  /** Database adapter (needed for ephemeral agent creation). */
  db?: DatabaseAdapter;
  /** Workspace ID (needed for ephemeral agent creation). */
  workspaceId?: string;
}

// ============================================================================
// PROMPT
// ============================================================================

const DECOMPOSE_PROMPT = `You are a task coordinator for an AI agent team. Given a task and available agents, create an execution plan where agents work in sequence. Each agent sees what previous agents produced.

Rules:
- Include only agents whose expertise is relevant. Skip agents that wouldn't add value.
- Order agents so earlier ones produce foundational work (research, data) and later ones refine or synthesize.
- Each step's prompt should tell the agent what to do, not what to be.
- Use dependsOn to create the sequence: step-2 depends on step-1, etc.
- Keep sequences short: 2-4 steps.
- If no available agent has the right expertise for a step, set agentId to "NEW" and describe the needed expertise in the expectedRole field. A specialist will be created automatically.

Respond in this exact JSON format (no markdown, no explanation):
{
  "name": "Brief sequence name",
  "steps": [
    {
      "id": "step-1",
      "agentId": "agent-uuid or NEW",
      "prompt": "What this agent should do",
      "dependsOn": [],
      "expectedRole": "only if agentId is NEW",
      "environment": "auto or local or cloud"
    }
  ]
}

Set environment to "local" for steps that access private data (CRM, contacts, local files). Set to "cloud" for steps that need powerful reasoning or browser access. Default to "auto".`;

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export async function decomposeIntoSequence(
  input: DecomposeInput
): Promise<SequenceDefinition | null> {
  const { prompt, agents, anthropic, modelRouter, ollamaModel } = input;

  if (agents.length === 0) return null;

  const agentList = agents
    .map((a) => `- ${a.name} (ID: ${a.id}, Role: ${a.role})`)
    .join('\n');

  const userMessage = `Task: ${prompt}\n\nAvailable agents:\n${agentList}`;

  try {
    let rawText: string | null = null;

    // Try Ollama first if available
    if (modelRouter) {
      try {
        const provider: ModelProvider = await modelRouter.getProvider('orchestrator');
        if (provider.name === 'ollama' && provider.createMessage) {
          const response = await provider.createMessage({
            model: ollamaModel || undefined,
            system: DECOMPOSE_PROMPT,
            messages: [{ role: 'user', content: userMessage }],
            maxTokens: 1000,
            temperature: 0.3,
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
        max_tokens: 1000,
        system: DECOMPOSE_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.3,
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        rawText = textBlock.text;
      }
    }

    if (!rawText) return null;

    // Parse JSON
    const trimmed = rawText.trim();
    // Strip <think> tags from qwen/deepseek models
    const cleaned = trimmed.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const jsonStr = cleaned.startsWith('{')
      ? cleaned
      : cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');

    const parsed = JSON.parse(jsonStr) as { name?: string; steps?: unknown[] };

    if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }

    // Validate steps (with ephemeral agent creation for NEW agents)
    const validAgentIds = new Set(agents.map((a) => a.id));
    const steps: SequenceStep[] = [];

    for (const rawStep of parsed.steps) {
      const step = rawStep as Record<string, unknown>;
      const id = step.id as string;
      let agentId = step.agentId as string;
      const stepPrompt = step.prompt as string;
      const dependsOn = (step.dependsOn as string[]) ?? [];
      const expectedRole = step.expectedRole as string | undefined;
      const environment = step.environment as 'local' | 'cloud' | 'auto' | undefined;

      if (!id || !agentId || !stepPrompt) continue;

      // Handle NEW agent requests — create ephemeral agent via factory
      if (agentId === 'NEW' && expectedRole && input.db && input.workspaceId) {
        const genesis = await createEphemeralAgent({
          expertiseNeeded: expectedRole,
          taskContext: stepPrompt,
          existingAgents: agents.map((a) => ({ name: a.name, role: a.role })),
          db: input.db,
          workspaceId: input.workspaceId,
          anthropic: input.anthropic,
          modelRouter: input.modelRouter,
        });

        if (genesis?.success) {
          agentId = genesis.agentId;
          validAgentIds.add(agentId);
        } else {
          continue;
        }
      }

      if (!validAgentIds.has(agentId)) continue;

      steps.push({ id, agentId, prompt: stepPrompt, dependsOn, expectedRole, environment });
    }

    if (steps.length === 0) return null;

    return {
      name: (parsed.name as string) ?? 'Sequence',
      steps,
      sourcePrompt: prompt,
    };
  } catch (err) {
    logger.warn({ err }, 'Sequence decomposition failed');
    return null;
  }
}
