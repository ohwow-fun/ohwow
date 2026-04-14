/**
 * OrchestratorRuntimeConfig — the mutable-settings bag that LocalOrchestrator
 * exposes to external callers (daemon startup, API routes) via ~15 setters.
 * Extracted so LocalOrchestrator doesn't have to house the state + every
 * setter body + every read site inline. Pure data; side effects (e.g.
 * propagating aliases to an already-constructed desktop service) stay
 * in the orchestrator's delegating setter so this module stays import-
 * free of runtime services.
 */

import type { ConnectorRegistry } from '../integrations/connector-registry.js';
import type { LspManager } from '../lsp/lsp-manager.js';
import type { MeetingSession } from '../meeting/meeting-session.js';

export interface RagConfigOptions {
  ollamaUrl?: string;
  embeddingModel?: string;
  ollamaModel?: string;
  ragBm25Weight?: number;
  rerankerEnabled?: boolean;
  meshRagEnabled?: boolean;
}

export interface InferenceCapabilities {
  turboQuantActive: boolean;
  turboQuantBits: 0 | 2 | 3 | 4;
}

export class OrchestratorRuntimeConfig {
  // RAG / embedding settings.
  ollamaUrl?: string;
  embeddingModel?: string;
  ollamaModel?: string;
  ragBm25Weight?: number;
  rerankerEnabled?: boolean;
  meshRagEnabled?: boolean;

  // Chrome profile aliases (email → profile directory).
  chromeProfileAliases: Record<string, string> = {};

  // TurboQuant KV cache compression.
  turboQuantActive = false;
  turboQuantBits: 0 | 2 | 3 | 4 = 0;

  // Cost confirmation + desktop gate.
  skipMediaCostConfirmation = false;
  desktopToolsEnabled = false;

  // Injected services + registries.
  connectorRegistry: ConnectorRegistry | null = null;
  lspManager?: LspManager;
  meetingSession?: MeetingSession;

  // Scheduler change callback — fired by tools that mutate agent schedules
  // so the scheduler can reload its cron table.
  onScheduleChange?: () => void;

  setRagConfig(opts: RagConfigOptions): void {
    this.ollamaUrl = opts.ollamaUrl;
    this.embeddingModel = opts.embeddingModel;
    this.ollamaModel = opts.ollamaModel;
    this.ragBm25Weight = opts.ragBm25Weight;
    this.rerankerEnabled = opts.rerankerEnabled;
    this.meshRagEnabled = opts.meshRagEnabled;
  }

  setChromeProfileAliases(aliases: Record<string, string> | undefined): void {
    this.chromeProfileAliases = aliases || {};
  }

  setTurboQuantBits(bits: 0 | 2 | 3 | 4): void {
    this.turboQuantBits = bits;
  }

  setInferenceCapabilities(caps: InferenceCapabilities): void {
    this.turboQuantActive = caps.turboQuantActive;
    this.turboQuantBits = caps.turboQuantBits;
  }

  setSkipMediaCostConfirmation(skip: boolean): void {
    this.skipMediaCostConfirmation = skip;
  }

  setConnectorRegistry(registry: ConnectorRegistry): void {
    this.connectorRegistry = registry;
  }

  setLspManager(manager: LspManager): void {
    this.lspManager = manager;
  }

  setMeetingSession(session: MeetingSession): void {
    this.meetingSession = session;
  }

  setScheduleChangeCallback(callback: (() => void) | undefined): void {
    this.onScheduleChange = callback;
  }

  /**
   * Advisory tier for the turbo-quant path: returns 2/3/4 when active,
   * undefined otherwise. Used by the chat loops to decide whether to
   * inflate context budgets.
   */
  getTurboQuantTierBits(): 2 | 3 | 4 | undefined {
    return this.turboQuantActive ? (this.turboQuantBits as 2 | 3 | 4) : undefined;
  }
}
