/**
 * agent_prompt dispatcher: call Claude with a prompt, feeding context.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const agentPromptDispatcher: ActionDispatcher = {
  actionType: 'agent_prompt',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const promptTemplate = (config.prompt as string) || (config.task_prompt as string) || '';
    if (!promptTemplate) {
      throw new Error('agent_prompt requires a prompt in action_config');
    }

    const prompt = resolveContextTemplate(promptTemplate, context);

    let systemPrompt = 'You are a helpful AI assistant.';
    const agentId = config.agent_id as string | undefined;
    if (agentId) {
      const { data: agent } = await deps.db.from('agent_workforce_agents')
        .select('name, role, system_prompt')
        .eq('id', agentId)
        .maybeSingle();
      if (agent) {
        const a = agent as { name: string; role: string; system_prompt: string };
        systemPrompt = a.system_prompt || `You are ${a.name}, a ${a.role || 'helpful assistant'}.`;
      }
    }

    const contextParts: string[] = [];
    for (const [key, value] of Object.entries(context)) {
      if (key === 'trigger') {
        contextParts.push(`Input data:\n${JSON.stringify(value, null, 2)}`);
      } else {
        contextParts.push(`${key} output:\n${JSON.stringify(value, null, 2)}`);
      }
    }

    const userMessage = contextParts.length > 0
      ? `${contextParts.join('\n\n')}\n\nYour task: ${prompt}`
      : `Task: ${prompt}`;

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic();

    const response = await anthropic.messages.create({
      model: (config.model as string) || 'claude-haiku-4-5-20251001',
      max_tokens: (config.max_tokens as number) || 2000,
      temperature: 0.5,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const outputText = response.content
      .filter((block) => block.type === 'text')
      .map((b) => 'text' in b ? (b as { text: string }).text : '')
      .join('\n');
    const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

    logger.info(`[ActionExecutor] agent_prompt completed (${tokensUsed} tokens)`);
    return { text: outputText, tokens_used: tokensUsed };
  },
};
