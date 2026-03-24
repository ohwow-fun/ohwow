/**
 * MCP → Anthropic Tool Adapter
 * Converts MCP ListToolsResult entries to Anthropic Tool format.
 * Tool names are namespaced as mcp__<serverName>__<toolName>.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolAnnotations } from './types.js';

/**
 * Convert an MCP tool to Anthropic Tool format.
 * Namespace: mcp__<serverName>__<toolName>
 */
export function mcpToolToAnthropic(serverName: string, mcpTool: McpTool): Tool {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: mcpTool.description || `${mcpTool.name} (from MCP server ${serverName})`,
    input_schema: (mcpTool.inputSchema as Tool['input_schema']) ?? {
      type: 'object' as const,
      properties: {},
    },
  };
}

/**
 * Extract MCP tool annotations from an MCP tool definition.
 * Returns undefined if no annotations are present.
 */
export function extractToolAnnotations(mcpTool: McpTool): McpToolAnnotations | undefined {
  const annotations = mcpTool.annotations as McpToolAnnotations | undefined;
  if (!annotations) return undefined;

  const result: McpToolAnnotations = {};
  if (annotations.readOnlyHint !== undefined) result.readOnlyHint = annotations.readOnlyHint;
  if (annotations.destructiveHint !== undefined) result.destructiveHint = annotations.destructiveHint;
  if (annotations.idempotentHint !== undefined) result.idempotentHint = annotations.idempotentHint;
  if (annotations.openWorldHint !== undefined) result.openWorldHint = annotations.openWorldHint;

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Extract the MCP server name and original tool name from a namespaced tool name. */
export function parseMcpToolName(namespacedName: string): { serverName: string; toolName: string } | null {
  const match = namespacedName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (!match) return null;
  return { serverName: match[1], toolName: match[2] };
}

/** Check whether a namespaced tool name belongs to MCP. */
export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__');
}
