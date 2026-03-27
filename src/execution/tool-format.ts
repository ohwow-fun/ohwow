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

/** Keep first sentence, cap at 120 chars. */
function compressDescription(desc: string): string {
  // Find first sentence boundary (". " or end of string)
  const periodIdx = desc.indexOf('. ');
  const firstSentence = periodIdx > 0 ? desc.slice(0, periodIdx + 1) : desc;
  if (firstSentence.length <= 120) return firstSentence;
  return firstSentence.slice(0, 117) + '...';
}

/** Strip description fields from JSON schema properties (keeps names, types, required). */
function stripParameterDescriptions(params: Record<string, unknown>): Record<string, unknown> {
  const result = { ...params };
  const props = result.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return result;

  const stripped: Record<string, Record<string, unknown>> = {};
  for (const [key, val] of Object.entries(props)) {
    const { description: _desc, ...rest } = val;
    stripped[key] = rest;
  }
  result.properties = stripped;
  return result;
}

/**
 * Compress tool definitions for tight context budgets.
 * Shortens descriptions to first sentence and strips parameter descriptions.
 * Preserves tool names, parameter names, types, enums, and required fields.
 */
export function compressToolsForContext(tools: OpenAITool[]): OpenAITool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: compressDescription(t.function.description),
      parameters: stripParameterDescriptions(t.function.parameters),
    },
  }));
}
