/**
 * Ephemeral Agent Factory (Local Runtime)
 *
 * Creates specialized agents on-the-fly when the Sequential decomposer
 * identifies a capability gap. Supports both Anthropic and Ollama.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ModelRouter, ModelProvider } from '../../execution/model-router.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AgentGenesisInput {
  expertiseNeeded: string;
  taskContext: string;
  existingAgents: Array<{ name: string; role: string }>;
  db: DatabaseAdapter;
  workspaceId: string;
  anthropic?: Anthropic;
  modelRouter?: ModelRouter | null;
}

export interface AgentGenesisResult {
  agentId: string;
  name: string;
  role: string;
  success: boolean;
  error?: string;
}

// ============================================================================
// PROMPT
// ============================================================================

const GENESIS_PROMPT = `You are creating a specialist AI agent for a team. Given the expertise gap and task context, generate an agent definition.

The agent must complement the existing team (don't duplicate their expertise).
The system prompt should be 2-3 paragraphs: describe the agent's deep expertise and working style.

Respond in this exact JSON format (no markdown):
{
  "name": "Short descriptive name (2-3 words)",
  "role": "One-line role description",
  "systemPrompt": "The full system prompt for this specialist",
  "tools": ["web_research", "deep_research"]
}

Available tools: web_research, deep_research, ocr, local_crm, scrape_url, search_knowledge.
Only include tools relevant to the expertise.`;

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export async function createEphemeralAgent(
  input: AgentGenesisInput
): Promise<AgentGenesisResult | null> {
  const { expertiseNeeded, taskContext, existingAgents, db, workspaceId, anthropic, modelRouter } = input;

  const teamList = existingAgents.length > 0
    ? existingAgents.map((a) => `- ${a.name} (${a.role})`).join('\n')
    : 'No existing agents.';

  const userMessage = `Expertise needed: ${expertiseNeeded}\n\nTask context: ${taskContext.slice(0, 500)}\n\nExisting team:\n${teamList}`;

  try {
    let rawText: string | null = null;

    // Try Ollama first
    if (modelRouter) {
      try {
        const provider: ModelProvider = await modelRouter.getProvider('orchestrator');
        if (provider.name === 'ollama' && provider.createMessage) {
          const response = await provider.createMessage({
            system: GENESIS_PROMPT,
            messages: [{ role: 'user', content: userMessage }],
            maxTokens: 800,
            temperature: 0.4,
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
        max_tokens: 800,
        system: GENESIS_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.4,
      });
      const textBlock = response.content.find((b) => b.type === 'text');
      if (textBlock && textBlock.type === 'text') rawText = textBlock.text;
    }

    if (!rawText) return null;

    // Parse — strip think tags
    const cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const jsonStr = cleaned.startsWith('{') ? cleaned : cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(jsonStr) as {
      name?: string;
      role?: string;
      systemPrompt?: string;
      tools?: string[];
    };

    if (!parsed.name || !parsed.role || !parsed.systemPrompt) return null;

    // Create agent in SQLite
    const config = JSON.stringify({
      model: 'auto',
      temperature: 0.3,
      max_tokens: 2000,
      tools_enabled: parsed.tools ?? ['web_research'],
      approval_required: true,
      autonomy_level: 1,
    });

    const { data: agent } = await db
      .from('agent_workforce_agents')
      .insert({
        workspace_id: workspaceId,
        name: parsed.name,
        role: parsed.role,
        description: `Auto-created specialist for: ${expertiseNeeded.slice(0, 100)}`,
        system_prompt: parsed.systemPrompt,
        config,
        status: 'active',
        lifecycle_stage: 'ephemeral',
        origin: 'auto_genesis',
      })
      .select('id')
      .single();

    if (!agent) return null;
    const agentId = (agent as { id: string }).id;

    // Record lifecycle event
    await db
      .from('agent_workforce_lifecycle_events')
      .insert({
        agent_id: agentId,
        workspace_id: workspaceId,
        event_type: 'created',
        to_stage: 'ephemeral',
        reason: `Auto-created for: ${expertiseNeeded.slice(0, 200)}`,
        metrics: JSON.stringify({ taskContext: taskContext.slice(0, 200) }),
      });

    logger.info(
      { agentId, name: parsed.name, role: parsed.role },
      '[AgentFactory] Created ephemeral agent'
    );

    return { agentId, name: parsed.name, role: parsed.role, success: true };
  } catch (err) {
    logger.warn({ err, expertiseNeeded }, '[AgentFactory] Failed to create ephemeral agent');
    return null;
  }
}
