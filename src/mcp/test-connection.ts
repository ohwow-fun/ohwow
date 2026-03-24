/**
 * MCP Connection Test Utility
 * Tests connectivity to an MCP server and discovers available tools.
 */

import type { McpServerConfig } from './types.js';
import { McpClientManager } from './client.js';

export interface McpTestResult {
  success: boolean;
  tools: Array<{ name: string; description: string }>;
  error?: string;
  latencyMs: number;
}

export async function testMcpConnection(server: McpServerConfig): Promise<McpTestResult> {
  const start = Date.now();
  try {
    const manager = await Promise.race([
      McpClientManager.connect([server]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Connection timed out after 10s')), 10_000),
      ),
    ]);

    const tools = manager.getToolDefinitions().map(t => ({
      name: t.name.replace(`mcp__${server.name}__`, ''),
      description: t.description || '',
    }));

    await manager.close();

    return {
      success: true,
      tools,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      tools: [],
      error: err instanceof Error ? err.message : 'Connection failed',
      latencyMs: Date.now() - start,
    };
  }
}
