/**
 * Shared tool format converters.
 * Converts Anthropic tool definitions to OpenAI format (used by Ollama).
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { OpenAITool } from './model-router.js';

/** Convert Anthropic tool definitions to OpenAI format for Ollama. */
export function convertToolsToOpenAI(tools: Tool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}
