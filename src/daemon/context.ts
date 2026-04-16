/**
 * DaemonContext
 *
 * Shared mutable struct threaded through the daemon boot sequence. Each
 * phase in `start.ts` populates its slice of the context and later phases
 * (plus shutdown) read from it. The type is `Partial<DaemonContext>` during
 * construction; `start.ts` narrows to `DaemonContext` once all phases have
 * run.
 */

import type express from 'express';
import type { Server } from 'http';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { RuntimeConfig } from '../config.js';
import type { initDatabase } from '../db/init.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { BusinessContext } from '../execution/types.js';
import type { ModelRouter } from '../execution/model-router.js';
import type { MLXManager } from '../lib/mlx-manager.js';
import type { LlamaCppManager } from '../lib/llama-cpp-manager.js';
import type { OllamaMonitor } from '../lib/ollama-monitor.js';
import type { ProcessMonitor } from '../lib/process-monitor.js';
import type { ScraplingService } from '../execution/scrapling/index.js';
import type { VoiceboxService } from '../voice/voicebox-service.js';
import type { ControlPlaneClient } from '../control-plane/client.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type { LocalOrchestrator } from '../orchestrator/local-orchestrator.js';
import type { ChannelRegistry } from '../integrations/channel-registry.js';
import type { ConnectorRegistry } from '../integrations/connector-registry.js';
import type { LocalTriggerEvaluator } from '../triggers/local-trigger-evaluator.js';
import type { MessageRouter } from '../integrations/message-router.js';
import type { DigitalBody } from '../body/digital-body.js';
import type { DigitalNervousSystem } from '../body/digital-nervous-system.js';
import type { DeviceDataFetcher } from '../data-locality/fetch-client.js';
import type { WhatsAppClient } from '../whatsapp/client.js';
import type { TelegramClient } from '../integrations/telegram/client.js';
import type { LocalScheduler } from '../scheduling/local-scheduler.js';
import type { ProactiveEngine } from '../planning/proactive-engine.js';
import type { ConnectorSyncScheduler } from '../scheduling/connector-sync-scheduler.js';
import type { DocumentWorker } from '../execution/workers/document-worker.js';
import type { PeerDiscovery } from '../peers/discovery.js';
import type { PeerMonitor } from '../peers/peer-monitor.js';
import type { TunnelResult } from '../tunnel/tunnel.js';

export interface DaemonContext {
  // Phase 1 — init
  config: RuntimeConfig;
  dataDir: string;
  pidPath: string;
  rawDb: ReturnType<typeof initDatabase>;
  db: DatabaseAdapter;
  bus: TypedEventBus<RuntimeEvents>;
  sessionToken: string;
  startTime: number;
  businessContext: BusinessContext;

  // Phase 2 — inference
  modelRouter: ModelRouter;
  mlxManager: MLXManager | null;
  llamaCppManager: LlamaCppManager | null;
  ollamaMonitor: OllamaMonitor | null;
  processMonitor: ProcessMonitor;
  warmupAbort: AbortController | null;

  // Phase 3 — services
  scraplingService: ScraplingService;
  voiceboxService: VoiceboxService;

  // Phase 4 — cloud + workspace
  controlPlane: ControlPlaneClient | null;
  workspaceId: string;

  // Phase 5 — orchestration
  engine: RuntimeEngine;
  orchestrator: LocalOrchestrator | null;
  channelRegistry: ChannelRegistry;
  connectorRegistry: ConnectorRegistry;
  triggerEvaluator: LocalTriggerEvaluator;
  messageRouter: MessageRouter | null;
  digitalBody: DigitalBody;
  digitalNS: DigitalNervousSystem;
  deviceFetcher: DeviceDataFetcher | null;

  // Phase 6 — HTTP
  app: express.Application;
  server: Server;

  // Phase 7 — channels + scheduling + extras
  waClient: WhatsAppClient | null;
  tgClient: TelegramClient | null;
  scheduler: LocalScheduler | null;
  proactiveEngine: ProactiveEngine | null;
  connectorSyncScheduler: ConnectorSyncScheduler | null;
  documentWorker: DocumentWorker;
  peerDiscovery: PeerDiscovery | null;
  peerMonitor: PeerMonitor | null;
  tunnel: TunnelResult | null;
}

export function createEmptyContext(): Partial<DaemonContext> {
  return {};
}
