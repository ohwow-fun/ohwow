/**
 * Local Orchestrator Tool Types
 * Replaces Supabase-based ToolContext with DatabaseAdapter for the local runtime.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type { ChannelRegistry } from '../integrations/channel-registry.js';
import type { ControlPlaneClient } from '../control-plane/client.js';
import type { ScraplingService } from '../execution/scrapling/index.js';
import type { ModelRouter } from '../execution/model-router.js';
import type { ConnectorRegistry } from '../integrations/connector-registry.js';
import type { LspManager } from '../lsp/lsp-manager.js';
import type { MeetingSession } from '../meeting/meeting-session.js';

export interface LocalToolContext {
  db: DatabaseAdapter;
  workspaceId: string;
  engine: RuntimeEngine;
  channels: ChannelRegistry;
  controlPlane: ControlPlaneClient | null;
  scraplingService?: ScraplingService;
  anthropicApiKey?: string;
  modelRouter?: ModelRouter | null;
  onScheduleChange?: () => void;
  workingDirectory?: string;
  /** Ollama URL for embedding and query expansion (from config) */
  ollamaUrl?: string;
  /** Embedding model name for RAG hybrid search (from config) */
  embeddingModel?: string;
  /** Ollama chat model for query expansion (from config) */
  ollamaModel?: string;
  /** BM25 weight for hybrid search (from config) */
  ragBm25Weight?: number;
  /** Enable LLM-based reranking of RAG results (from config) */
  rerankerEnabled?: boolean;
  /** Enable mesh-distributed RAG retrieval across peers (from config) */
  meshRagEnabled?: boolean;
  /** Connector registry for data source sync */
  connectorRegistry?: ConnectorRegistry;
  /** LSP manager for code intelligence tools */
  lspManager?: LspManager;
  /** Active meeting session for live audio capture + transcription */
  meetingSession?: MeetingSession;
  /**
   * The agent currently running this tool, when invoked inside an agent task.
   * Undefined during orchestrator chat. Used by the `llm` organ to load
   * per-agent model policy (see AgentModelPolicy in execution-policy.ts).
   */
  currentAgentId?: string;
  /**
   * The active chat session id (1:1 with orchestrator_conversations.id).
   * Set by runChat so tools can read or mutate conversation-scoped state —
   * e.g. activate_guide_persona writes the active persona into
   * orchestrator_conversations.metadata so subsequent turns run under the
   * assigned guide agent's prompt + model. Undefined during agent tasks.
   */
  sessionId?: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Triggers agent execution via RuntimeEngine */
  executeAgent?: { agentId: string; prompt: string; projectId?: string };
  /** Triggers TUI tab switching */
  switchTab?: string;
  /** Path that needs user permission to access */
  needsPermission?: string;
}

export type ToolHandler = (
  ctx: LocalToolContext,
  input: Record<string, unknown>,
) => Promise<ToolResult> | ToolResult;
