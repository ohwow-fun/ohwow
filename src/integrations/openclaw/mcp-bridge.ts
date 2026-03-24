/**
 * OpenClaw MCP Bridge
 * Builds an McpServerConfig that launches the OpenClaw MCP shim as a subprocess.
 * This integrates OpenClaw skills into the existing MCP infrastructure.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { McpServerConfig } from '../../mcp/types.js';
import type { OpenClawConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build an MCP server config that launches the OpenClaw shim process.
 * The shim translates MCP tool calls into sandboxed OpenClaw skill executions.
 */
export function buildMcpServerConfig(config: OpenClawConfig): McpServerConfig {
  const shimPath = join(__dirname, 'openclaw-mcp-shim.js');

  return {
    name: 'openclaw',
    transport: 'stdio' as const,
    command: 'node',
    args: [shimPath],
    env: {
      OPENCLAW_BINARY: config.binaryPath,
      OPENCLAW_ALLOWLIST: JSON.stringify(config.allowlistedSkills),
      OPENCLAW_RATE_LIMIT_MINUTE: String(config.rateLimitPerMinute),
      OPENCLAW_RATE_LIMIT_HOUR: String(config.rateLimitPerHour),
      OPENCLAW_ALLOW_NETWORK: config.sandboxAllowNetwork ? '1' : '0',
      OPENCLAW_MAX_EXECUTION_MS: String(config.maxExecutionTimeMs),
    },
  };
}
