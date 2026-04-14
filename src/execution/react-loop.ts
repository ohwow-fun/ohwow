/**
 * Anthropic ReAct tool loop — the ~380-LOC hot-path block inside
 * RuntimeEngine.executeTask's `} else if (tools.length > 0) {` branch.
 *
 * C7a scaffold (this commit): signature, types, and wiring stub only.
 * The body moves in C7b so the change is bisectable — if C7a breaks
 * compile, we revert one trivial commit. If C7b breaks a smoke test,
 * we revert one 380-LOC commit without losing the type scaffolding.
 *
 * The function mutates `services` and `caps.fileAccessGuard` in place
 * so the outer `finally` in executeTask can still close the browser/
 * desktop/MCP clients that got activated mid-loop.
 */

import type { MessageParam, Tool, WebSearchTool20250305 } from '@anthropic-ai/sdk/resources/messages/messages';
import type { RuntimeEngine } from './engine.js';
import type { TaskCapabilities } from './task-capabilities.js';
import type { LocalBrowserService } from './browser/index.js';
import type { LocalDesktopService } from './desktop/index.js';
import type { FileAccessGuard } from './filesystem/index.js';
import type { McpClientManager } from '../mcp/index.js';
import type { ReActStep } from './task-completion.js';

export interface ReActServicesHolder {
  browserService: LocalBrowserService | null;
  browserActivated: boolean;
  desktopService: LocalDesktopService | null;
  desktopActivated: boolean;
}

export interface ReActLoopArgs {
  systemPrompt: string;
  systemPromptHash: string;
  messages: MessageParam[];
  tools: Array<WebSearchTool20250305 | Tool>;
  caps: TaskCapabilities;
  services: ReActServicesHolder;
  mcpClients: McpClientManager | null;
  fileAccessGuard: FileAccessGuard | null;
  taskId: string;
  agentId: string;
  workspaceId: string;
  task: {
    title: string;
    input: string | unknown;
    goal_id: string | null;
  };
  agentConfig: Record<string, unknown>;
  agent: { name: string };
  modelId: string;
  contextLimit: number;
  llmCache: unknown;
  agentBudget: unknown;
  startTime: number;
  traceId: string;
  taskInput: string | null;
}

export interface ReActLoopResult {
  fullContent: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  reactTrace: ReActStep[];
  anthropicToolsUsed: string[];
  /**
   * When set, the ReAct loop returned early because the agent paused
   * (e.g. a mid-loop checkpoint signalled a user intervention). The
   * caller should skip the completion pipeline and return this result
   * directly.
   */
  paused?: {
    output: string;
    tokensUsed: number;
    costCents: number;
  };
}

/**
 * C7a scaffold — not wired up yet. The body moves in C7b.
 */
// eslint-disable-next-line require-yield, @typescript-eslint/no-unused-vars
export async function runAnthropicReActLoop(
  this: RuntimeEngine,
  _args: ReActLoopArgs,
): Promise<ReActLoopResult> {
  void this;
  throw new Error('runAnthropicReActLoop scaffold (C7a) — body lands in C7b');
}
