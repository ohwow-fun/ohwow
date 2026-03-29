/**
 * RuntimeEngine Types
 * Types for the local runtime's task execution engine.
 */

import type { ClaudeModel } from './ai-types.js';
import type { McpServerConfig } from '../mcp/types.js';

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
  /** Data directory for storing screenshots and other artifacts */
  dataDir?: string;
  /** Global MCP server defaults available to all agents */
  mcpServers?: McpServerConfig[];
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
