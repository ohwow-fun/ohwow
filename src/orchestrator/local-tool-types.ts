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
  /** Connector registry for data source sync */
  connectorRegistry?: ConnectorRegistry;
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
