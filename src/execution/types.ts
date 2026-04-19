/**
 * RuntimeEngine Types
 * Types for the local runtime's task execution engine.
 */

import type { ClaudeModel } from './ai-types.js';
import type { McpServerConfig } from '../mcp/types.js';
import type { ClaudeCodeCliPermissionMode } from '../config.js';

// ============================================================================
// ENGINE CONFIG
// ============================================================================

export interface EngineConfig {
  /** Anthropic API key (customer's own key) */
  anthropicApiKey: string;
  /** Default model to use when agent config doesn't specify one */
  defaultModel: ClaudeModel;
  /** Max tool-use loop iterations */
  maxToolLoopIterations: number;
  /** Run browser in headless mode (default: true) */
  browserHeadless: boolean;
  /** Browser target: 'chromium' (isolated) or 'chrome' (real Chrome via CDP) */
  browserTarget?: 'chromium' | 'chrome';
  /** CDP port for Chrome remote debugging */
  chromeCdpPort?: number;
  /** Data directory for storing screenshots and other artifacts */
  dataDir?: string;
  /** Global MCP server defaults available to all agents */
  mcpServers?: McpServerConfig[];
  /** Path to claude CLI binary (empty = auto-detect from PATH) */
  claudeCodeCliPath?: string;
  /** Model override for Claude Code CLI executor */
  claudeCodeCliModel?: string;
  /** Max tool iterations for Claude Code CLI (default: 25) */
  claudeCodeCliMaxTurns?: number;
  /** Permission mode for Claude Code CLI (default: 'skip') */
  claudeCodeCliPermissionMode?: ClaudeCodeCliPermissionMode;
  /** Auto-detect and prefer Claude Code CLI for code-capable agents (default: true) */
  claudeCodeCliAutodetect?: boolean;
  /** Model source from global config */
  modelSource?: string;
  /** Daemon port for API callbacks from Claude Code */
  daemonPort?: number;
  /** Daemon auth token for API callbacks */
  daemonToken?: string;
  /**
   * Workspace-level kill switch for desktop control tools. When false
   * (default), agents can never call desktop tools regardless of their
   * own per-agent `desktop_enabled` flag — the workspace setting wins.
   * When true, the existing per-agent gate determines whether a given
   * agent gets desktop tools.
   */
  desktopToolsEnabled?: boolean;
  /**
   * Workspace slug (e.g. 'default', 'avenued'). When set, browser-enabled
   * tasks are serialized per workspace via BrowserJobQueue so that two
   * tasks in the same workspace never race on the same CDP surface.
   */
  workspaceName?: string;
}

// ============================================================================
// RUNTIME EFFECTS (side effects injected into engine)
// ============================================================================

export interface RuntimeEffects {
  /** Report task operational data to cloud (titles, status, costs — no prompts or outputs) */
  reportToCloud: (report: TaskReport) => Promise<void>;
}

export interface TaskReport {
  runtimeTaskId: string;
  agentId: string;
  taskTitle: string;
  status: string;
  tokensUsed: number;
  costCents: number;
  durationSeconds?: number;
  modelUsed?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  /** Task output text for cloud dashboard display. */
  taskOutput?: string;
  /** React trace for replay tab. */
  reactTrace?: Array<{ thought: string; actions: Array<{ tool: string; inputSummary?: string }>; iteration: number; durationMs?: number; observations?: Array<{ tool: string; success: boolean; resultSummary?: string }> }>;
  /** Memories extracted from this task, filtered by agent sync policy. */
  memories?: import('../control-plane/types.js').TaskReportMemories;
  /** State updates from this task, for cloud-side persistence. */
  stateUpdates?: import('../control-plane/types.js').TaskReportStateUpdate[];
  /** Goal progress increment triggered by this task completion. */
  goalProgress?: { goalId: string; newValue: number; completed: boolean };
}

// ============================================================================
// EXECUTION RESULT
// ============================================================================

export interface ExecuteAgentResult {
  success: boolean;
  taskId: string;
  status: string;
  output?: unknown;
  error?: string;
  tokensUsed: number;
  costCents: number;
  responseType?: 'deliverable' | 'informational';
  traceId?: string;
}

// ============================================================================
// BUSINESS CONTEXT (synced from cloud)
// ============================================================================

export interface BusinessContext {
  businessName: string;
  businessType: string;
  businessDescription?: string;
}
