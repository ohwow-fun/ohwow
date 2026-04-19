/**
 * WorkspaceContext
 *
 * Represents all runtime state scoped to a single workspace within the
 * multi-workspace daemon. Each workspace loaded by WorkspaceRegistry gets
 * its own instance. The primary workspace also has its fields aliased onto
 * the top-level DaemonContext for backward compatibility.
 */

import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { RuntimeConfig } from '../config.js';
import type { initDatabase } from '../db/init.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { BusinessContext } from '../execution/types.js';
import type { ControlPlaneClient } from '../control-plane/client.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type { LocalOrchestrator } from '../orchestrator/local-orchestrator.js';
import type { ChannelRegistry } from '../integrations/channel-registry.js';
import type { ConnectorRegistry } from '../integrations/connector-registry.js';
import type { LocalTriggerEvaluator } from '../triggers/local-trigger-evaluator.js';
import type { MessageRouter } from '../integrations/message-router.js';
import type { LocalScheduler } from '../scheduling/local-scheduler.js';
import type { ProactiveEngine } from '../planning/proactive-engine.js';
import type { ConnectorSyncScheduler } from '../scheduling/connector-sync-scheduler.js';

export interface WorkspaceContext {
  /** Workspace slug (e.g. 'default', 'avenued') */
  workspaceName: string;
  /** Cloud workspace UUID (or 'local' for unconnected workspaces) */
  workspaceId: string;
  /** On-disk data directory for this workspace */
  dataDir: string;
  /** JWT session token for authenticating requests to this workspace */
  sessionToken: string;

  /** Raw better-sqlite3 handle */
  rawDb: ReturnType<typeof initDatabase>;
  /** High-level DB adapter */
  db: DatabaseAdapter;
  /** Runtime config (potentially with workspace-specific overrides) */
  config: RuntimeConfig;
  /** Business identity row from agent_workforce_workspaces */
  businessContext: BusinessContext;

  /** Execution engine — null until createEngine has run */
  engine: RuntimeEngine | null;
  /** Orchestrator — null for workers and secondary workspaces in Phase 2 */
  orchestrator: LocalOrchestrator | null;
  /** Trigger evaluator — null until setupOrchestration has run */
  triggerEvaluator: LocalTriggerEvaluator | null;
  /** Channel registry — null until setupOrchestration has run */
  channelRegistry: ChannelRegistry | null;
  /** Connector registry — null until setupOrchestration has run */
  connectorRegistry: ConnectorRegistry | null;
  /** Message router — null for workers and secondary workspaces in Phase 2 */
  messageRouter: MessageRouter | null;

  /** Cron-based task scheduler — null until initializeScheduling has run */
  scheduler: LocalScheduler | null;
  /** Proactive background engine — null until initializeScheduling has run */
  proactiveEngine: ProactiveEngine | null;
  /** Connector-sync background scheduler — null until initializeScheduling has run */
  connectorSyncScheduler: ConnectorSyncScheduler | null;

  /**
   * Cloud control plane client. Null for secondary workspaces in Phase 2 —
   * connectCloudAndConsolidate is left unchanged and only runs for the primary.
   */
  controlPlane: ControlPlaneClient | null;

  /**
   * Per-workspace event bus. Must NOT be shared between workspaces — bus
   * events from workspace A must not fire listeners in workspace B.
   */
  bus: TypedEventBus<RuntimeEvents>;
}
