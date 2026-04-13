/**
 * MCP → Anthropic Tool Adapter
 * Converts MCP ListToolsResult entries to Anthropic Tool format.
 * Tool names are namespaced as mcp__<serverName>__<toolName>.
 *
 * When the namespaced name would exceed the provider tool-name limit
 * (64 chars on Anthropic + OpenAI), the caller can pass an overrideName
 * so McpClientManager can supply a deterministic shortened alias. The
 * dispatcher resolves both the long and the short form via the toolMap
 * synonyms maintained in McpClientManager.connectServer.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolAnnotations } from './types.js';
import { createHash } from 'node:crypto';

/** Maximum allowed tool name length on Anthropic + OpenAI APIs. */
export const MAX_TOOL_NAME_LENGTH = 64;

/** Build the namespaced form used for both display and lookups. */
export function namespacedMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Build a deterministic short alias for an MCP tool whose namespaced name
 * exceeds the provider tool-name limit. Keeps the `mcp__<server>__` prefix
 * (so existing isMcpTool / parseMcpToolName / agent-allowlist call sites
 * that rely on the prefix continue to work) and replaces the tool name
 * segment with a hash-suffixed truncation of the original. Stable across
 * reconnects because the hash is computed from (serverName, toolName).
 *
 * If even the server name alone exceeds the budget, returns the namespaced
 * form unchanged — the caller will log the warning and the upstream
 * provider will reject the request, which is the right failure mode (the
 * operator must rename their server).
 */
export function shortAliasForMcpTool(serverName: string, toolName: string): string {
  const prefix = `mcp__${serverName}__`;
  if (prefix.length >= MAX_TOOL_NAME_LENGTH) {
    return namespacedMcpToolName(serverName, toolName);
  }
  const hash = createHash('sha1').update(`${serverName}::${toolName}`).digest('hex').slice(0, 8);
  // Reserve room for hash + the underscore separator between head and hash.
  const budget = MAX_TOOL_NAME_LENGTH - prefix.length - hash.length - 1;
  const head = budget > 0 ? toolName.slice(0, budget) : '';
  const aliasTool = head ? `${head}_${hash}` : hash;
  return `${prefix}${aliasTool}`;
}

/**
 * Convert an MCP tool to Anthropic Tool format.
 * Namespace: mcp__<serverName>__<toolName>
 *
 * If displayName is provided, it overrides the default namespaced name.
 * Used by McpClientManager to substitute a short alias when the
 * namespaced name would blow past MAX_TOOL_NAME_LENGTH.
 */
export function mcpToolToAnthropic(
  serverName: string,
  mcpTool: McpTool,
  displayName?: string,
): Tool {
  const name = displayName ?? namespacedMcpToolName(serverName, mcpTool.name);
  return {
    name,
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
