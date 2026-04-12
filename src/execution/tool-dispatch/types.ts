/**
 * Tool Dispatch Types
 *
 * Interfaces for the strategy-based tool execution pattern.
 * Each ToolExecutor handles one category of tools.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ScraplingService } from '../scrapling/index.js';
import type { FileAccessGuard } from '../filesystem/index.js';
import type { McpClientManager } from '../../mcp/index.js';
import type { LocalBrowserService } from '../browser/local-browser.service.js';
import type { LocalDesktopService } from '../desktop/local-desktop.service.js';
import type { DesktopServiceOptions } from '../desktop/desktop-types.js';
import type { CircuitBreaker } from '../../orchestrator/error-recovery.js';
import type { DocMountManager } from '../doc-mounts/mount-manager.js';
import type { ModelRouter } from '../model-router.js';

/** Context shared across all tool executors for a single task execution */
export interface ToolExecutionContext {
  taskId: string;
  agentId: string;
  workspaceId: string;
  goalId?: string;
  dataDir?: string;
  browserHeadless?: boolean;
  scraplingService: ScraplingService;
  fileAccessGuard: FileAccessGuard | null;
  mcpClients: McpClientManager | null;
  circuitBreaker: CircuitBreaker;
  db: DatabaseAdapter;
  /** Mutable: set when browser is activated on-demand */
  browserService: LocalBrowserService | null;
  browserActivated: boolean;
  /** Mutable: set when desktop control is activated on-demand */
  desktopService: LocalDesktopService | null;
  desktopActivated: boolean;
  /** Desktop service options (allowedApps, autonomyLevel, etc.) from agent config */
  desktopOptions?: Partial<DesktopServiceOptions>;
  /** Doc mount manager for documentation filesystem mounts */
  docMountManager: DocMountManager | null;
  /** Whether git-aware env scrubbing is enabled (preserves SSH_AUTH_SOCK for git push) */
  gitEnabled?: boolean;
  /**
   * Model router for the `llm` organ. Exposes per-sub-task provider +
   * model selection to tool executors so agents can act as mini
   * sub-orchestrators instead of being pinned to a single model.
   */
  modelRouter: ModelRouter | null;
}

/** Result from a tool execution */
export interface ToolCallResult {
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  is_error?: boolean;
  /** Side effect: browser was activated during this call */
  browserActivated?: boolean;
  /** Side effect: desktop was activated during this call */
  desktopActivated?: boolean;
  /** Side effect: doc mount paths to add to FileAccessGuard */
  mountedDocPaths?: string[];
}

/** Strategy interface for tool execution */
export interface ToolExecutor {
  /** Check if this executor can handle the given tool name */
  canHandle(toolName: string): boolean;
  /** Execute the tool and return the result */
  execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult>;
}
