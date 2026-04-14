/**
 * Local Orchestrator
 * Conversational AI assistant for the local TUI runtime.
 * Uses async generator for streaming events (not SSE like the web version).
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type { IntentSection } from './tool-definitions.js';
import { getWorkingNumCtx, getParameterTier } from '../lib/ollama-models.js';
import { detectDevice } from '../lib/device-info.js';
import { ContextBudget } from './context-budget.js';
import type { LocalToolContext, ToolResult } from './local-tool-types.js';
import type { ChannelRegistry } from '../integrations/channel-registry.js';
import type { ConnectorRegistry } from '../integrations/connector-registry.js';
import { OrchestratorRuntimeConfig, type RagConfigOptions, type InferenceCapabilities } from './orchestrator-runtime-config.js';
import { PermissionBroker } from './orchestrator-approvals.js';
import { activateBrowserSession } from './orchestrator-sessions.js';
import { McpLifecycle, type McpReloadStatus } from './orchestrator-mcp-lifecycle.js';
import { assembleOrchestratorToolSurface } from './orchestrator-tool-surface.js';
import {
  createEmptyPhilosophicalLayers,
  initPhilosophicalLayers,
  type PhilosophicalLayers,
} from './orchestrator-philosophical-layers.js';
import { runAnthropicChat } from './orchestrator-chat-anthropic.js';
import { runOllamaChat } from './orchestrator-chat-ollama.js';
import { runOpenRouterChat } from './orchestrator-chat-openrouter.js';
import type { ControlPlaneClient } from '../control-plane/client.js';
import { type ModelRouter, type ModelResponse, type ModelProvider, type ModelSourceOption, OllamaProvider, OpenRouterProvider } from '../execution/model-router.js';
import type { ScraplingService } from '../execution/scrapling/index.js';
import type { McpServerConfig } from '../mcp/types.js';
import { LocalBrowserService } from '../execution/browser/local-browser.service.js';
import { LocalDesktopService } from '../execution/desktop/local-desktop.service.js';
import {
  type OrchestratorEvent,
  type ClassifiedIntent,
  type ChannelChatOptions,
  type ChatTurnOptions,
  MODEL,
  stripThinkTags,
  ThinkTagFilter,
} from './orchestrator-types.js';
import {
  loadHistory,
  saveToSession,
  type SessionDeps,
  type MemoryExtractionDeps,
} from './session-store.js';
import {
  buildFullPrompt,
  type PromptBuilderDeps,
} from './prompt-builder.js';
import {
  type BrowserState,
  type DesktopState,
  type ToolExecutionContext,
} from './tool-executor.js';
import { CircuitBreaker } from './error-recovery.js';
import { ToolCache } from './tool-cache.js';
import { runSubOrchestrator, getFocusSections, getTimeoutForFocus, type SubOrchestratorResult } from './sub-orchestrator.js';
import { logger } from '../lib/logger.js';
import { withTimeout, createTimeoutController } from '../lib/with-timeout.js';

/**
 * Per-iteration model call timeout. Applies to every provider.createMessage,
 * anthropic.messages.create, and the first-chunk wait on streaming calls.
 * 5 minutes is generous enough for healthy slow responses (large context,
 * complex tool use) but short enough that a hung upstream API gets caught
 * within the user's patience window. Override via OHWOW_MODEL_CALL_TIMEOUT_MS.
 *
 * Bug #6 fix: without this, a hanging upstream API freezes the chat turn
 * forever — no error, no recovery, only daemon restart.
 */
const MODEL_CALL_TIMEOUT_MS = (() => {
  const fromEnv = parseInt(process.env.OHWOW_MODEL_CALL_TIMEOUT_MS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 300_000;
})();
import { Brain } from '../brain/brain.js';
import { createBrowserOrgan, createDesktopOrgan, createMcpOrgan, type DigitalBody } from '../body/digital-body.js';
import { BodyStateService } from '../body/body-state.js';
import { Soul } from '../persona/soul.js';

export type { OrchestratorEvent, ChannelChatOptions, ChatTurnOptions } from './orchestrator-types.js';
export type { IntentSection } from './tool-definitions.js';

export class LocalOrchestrator {
  anthropic: Anthropic;
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
  channels: ChannelRegistry;
  controlPlane: ControlPlaneClient | null;
  modelRouter: ModelRouter | null;
  scraplingService: ScraplingService | undefined;
  anthropicApiKey: string;
  orchestratorModel: string;
  workingDirectory: string;
  browserHeadless: boolean;
  browserTarget: 'chromium' | 'chrome';
  chromeCdpPort: number;
  dataDir: string;
  browserService: LocalBrowserService | null = null;
  browserActivated = false;
  browserRequestedProfile: string | undefined;
  /**
   * Non-null when the most recent browser activation fell through from
   * CDP-attached mode to an isolated bundled Chromium. Tool executors
   * read this via `getBrowserDegradedReason()` and surface it to the
   * LLM so the next turn stops assuming a logged-in session.
   */
  _browserDegradedReason: string | null = null;
  desktopService: LocalDesktopService | null = null;
  desktopActivated = false;
  filesystemActivated = false;
  config = new OrchestratorRuntimeConfig();
  broker: PermissionBroker;
  exchangeCount = 0;
  lastIntentBySession = new Map<string, ClassifiedIntent>();
  circuitBreaker = new CircuitBreaker();
  toolCache = new ToolCache();
  mcp!: McpLifecycle;
  /**
   * Workspace-level kill switch for desktop control tools. When false
   * (default), the orchestrator does NOT inject request_desktop or any
   * desktop_* tools into its surface unless the user message was
   * explicitly classified as a desktop intent (intent classifier
   * returned `desktop`). This stops the "confused model takes a
   * screenshot of an unrelated app and laundering its contents into the
   * response" pathology. Enable per-workspace via workspace.json
   * `desktopToolsEnabled: true` or globally via OHWOW_DESKTOP_TOOLS_ENABLED.
   * Stored on `this.config.desktopToolsEnabled`.
   */
  /** Unified Brain: philosophical cognitive coordinator. */
  brain: Brain | null = null;
  /** Soul: deep human persona awareness (Aristotle's Psyche). */
  soul = new Soul();
  /** Digital Body: the agent's embodied capabilities (Merleau-Ponty). */
  digitalBody: DigitalBody | null = null;
  /** Body State Service: unified system health reporting. */
  bodyStateService: BodyStateService | null = null;

  // Philosophical layers — lazy, non-blocking init. All 8 populate
  // asynchronously via initPhilosophicalLayers (helpers/fire-and-forget).
  layers: PhilosophicalLayers = createEmptyPhilosophicalLayers();
  get affectEngine() { return this.layers.affectEngine; }
  get endocrineSystem() { return this.layers.endocrineSystem; }
  get homeostasisController() { return this.layers.homeostasisController; }
  get immuneSystem() { return this.layers.immuneSystem; }
  get narrativeEngine() { return this.layers.narrativeEngine; }
  get ethicsEngine() { return this.layers.ethicsEngine; }
  get habitEngine() { return this.layers.habitEngine; }
  get sleepCycle() { return this.layers.sleepCycle; }

  get sessionDeps(): SessionDeps {
    return { db: this.db, workspaceId: this.workspaceId };
  }

  get memoryDeps(): MemoryExtractionDeps {
    return { db: this.db, workspaceId: this.workspaceId, anthropicApiKey: this.anthropicApiKey, anthropic: this.anthropic, modelRouter: this.modelRouter };
  }

  get browserState(): BrowserState {
    return {
      service: this.browserService,
      activated: this.browserActivated,
      headless: this.browserHeadless,
      dataDir: this.dataDir,
      requestedProfile: this.browserRequestedProfile,
      setRequestedProfile: (profile: string) => { this.browserRequestedProfile = profile; },
      activate: async () => {
        if (!this.browserService) {
          await this.activateBrowser(this.browserRequestedProfile);
        }
        return this.browserService;
      },
    };
  }

  /** Called by tool executor to set the requested Chrome profile */
  setBrowserRequestedProfile(profile: string | undefined): void {
    this.browserRequestedProfile = profile;
  }

  /**
   * In-flight singleflight promise for the current browser activation.
   * Without it, two concurrent chats both calling `request_browser`
   * (or both pre-activating via the browser intent classifier) each
   * spawn their own Chromium process and race on this.browserService /
   * this.browserActivated. Bug #6 family.
   */
  browserActivateInFlight: Promise<void> | null = null;

  /** Activate browser — connects to real Chrome via CDP or launches Chromium.
   *  Singleflight: concurrent callers share one in-flight launch. */
  async activateBrowser(requestedProfile?: string): Promise<void> {
    if (this.browserActivated && this.browserService) return;

    if (!this.browserActivateInFlight) {
      this.browserActivateInFlight = this.doActivateBrowser(requestedProfile).catch((err) => {
        this.browserActivateInFlight = null;
        throw err;
      });
    }

    try {
      await this.browserActivateInFlight;
    } finally {
      if (this.browserActivated && this.browserService) {
        this.browserActivateInFlight = null;
      }
    }
  }

  async doActivateBrowser(requestedProfile?: string): Promise<void> {
    const { service, degradedReason } = await activateBrowserSession({
      requestedProfile,
      browserHeadless: this.browserHeadless,
      browserTarget: this.browserTarget,
      chromeCdpPort: this.chromeCdpPort,
      chromeProfileAliases: this.config.chromeProfileAliases,
    });
    this.browserService = service;
    this._browserDegradedReason = degradedReason;
    this.browserActivated = true;
    this.syncOrganToBody();
  }

  /**
   * Non-null when the last browser activation fell back from
   * CDP-attached to isolated Chromium. Tool executors surface this
   * string in the request_browser response so the LLM can see it
   * in its next turn's prompt and adjust — most importantly, it
   * will stop attempting actions that require a logged-in session
   * (posting to X, editing a Product Hunt draft, etc).
   */
  getBrowserDegradedReason(): string | null {
    return this._browserDegradedReason;
  }

  get desktopState(): DesktopState {
    return { service: this.desktopService, activated: this.desktopActivated, dataDir: this.dataDir };
  }

  buildToolCtx(sessionId?: string): LocalToolContext {
    return {
      db: this.db,
      workspaceId: this.workspaceId,
      engine: this.engine,
      channels: this.channels,
      controlPlane: this.controlPlane,
      scraplingService: this.scraplingService,
      anthropicApiKey: this.anthropicApiKey,
      modelRouter: this.modelRouter,
      onScheduleChange: this.config.onScheduleChange,
      workingDirectory: this.workingDirectory || undefined,
      ollamaUrl: this.config.ollamaUrl,
      embeddingModel: this.config.embeddingModel,
      ollamaModel: this.config.ollamaModel,
      ragBm25Weight: this.config.ragBm25Weight,
      rerankerEnabled: this.config.rerankerEnabled,
      meshRagEnabled: this.config.meshRagEnabled,
      connectorRegistry: this.config.connectorRegistry || undefined,
      lspManager: this.config.lspManager,
      meetingSession: this.config.meetingSession,
      sessionId,
      // Per-turn chat actor context: when the cloud chat bridge forwards
      // a member-impersonated turn (chatUserName + personaAgentId), the
      // /api/chat handler stashes the resolved team_member id + guide
      // agent id on a per-session map so concurrent dispatches don't
      // race on a single instance field. Used by the deliverables
      // recorder to attribute artifacts to the right member + actor.
      // Falls back to the legacy single-instance fields when no
      // session-scoped actor is set (preserves channel chat behavior).
      currentTeamMemberId: this.resolveChatActorTeamMemberId(sessionId),
      currentGuideAgentId: this.resolveChatActorGuideAgentId(sessionId),
    };
  }

  /**
   * Per-session chat actor map. Keyed by sessionId so concurrent dispatches
   * with different sessions don't clobber each other. Bug #6 fix — replaces
   * the single-instance _chatActorTeamMemberId / _chatActorGuideAgentId
   * fields that race when the route handler set+cleared them around the
   * background generator dispatch.
   */
  _chatActorBySession = new Map<string, { teamMemberId?: string; guideAgentId?: string }>();

  /**
   * Set the chat actor for a specific session. The /api/chat handler calls
   * this before dispatching the background generator, then clearChatActorForSession
   * in the finally. Old callers still using the legacy setter (setChatActor)
   * continue to write to the single-instance field which serves as the
   * fallback when no per-session entry exists.
   */
  setChatActorForSession(
    sessionId: string,
    actor: { teamMemberId: string | null; guideAgentId: string | null } | null,
  ): void {
    if (actor === null) {
      this._chatActorBySession.delete(sessionId);
      return;
    }
    this._chatActorBySession.set(sessionId, {
      teamMemberId: actor.teamMemberId ?? undefined,
      guideAgentId: actor.guideAgentId ?? undefined,
    });
  }

  /** Clear the per-session chat actor entry (called by the async dispatch finally). */
  clearChatActorForSession(sessionId: string): void {
    this._chatActorBySession.delete(sessionId);
  }

  resolveChatActorTeamMemberId(sessionId?: string): string | undefined {
    if (sessionId) {
      const entry = this._chatActorBySession.get(sessionId);
      if (entry) return entry.teamMemberId;
    }
    return this._chatActorTeamMemberId;
  }

  resolveChatActorGuideAgentId(sessionId?: string): string | undefined {
    if (sessionId) {
      const entry = this._chatActorBySession.get(sessionId);
      if (entry) return entry.guideAgentId;
    }
    return this._chatActorGuideAgentId;
  }

  /**
   * Stash the current chat actor on the instance (legacy single-flight path).
   * Kept for backward compatibility with callers that haven't migrated to the
   * per-session API. New concurrent-safe code should use setChatActorForSession.
   */
  setChatActor(actor: { teamMemberId: string | null; guideAgentId: string | null } | null): void {
    this._chatActorTeamMemberId = actor?.teamMemberId ?? undefined;
    this._chatActorGuideAgentId = actor?.guideAgentId ?? undefined;
  }
  _chatActorTeamMemberId?: string;
  _chatActorGuideAgentId?: string;

  buildToolExecCtx(executedToolCalls: Map<string, ToolResult>, options?: ChannelChatOptions, sessionId?: string): ToolExecutionContext {
    return {
      toolCtx: this.buildToolCtx(sessionId),
      executedToolCalls,
      browserState: this.browserState,
      desktopState: this.desktopState,
      waitForPermission: (requestId: string) => this.broker.waitForPermission(requestId),
      addAllowedPath: (path: string) => this.broker.addAllowedPath(path),
      options,
      circuitBreaker: this.circuitBreaker,
      toolCache: this.toolCache,
      delegateSubtask: (prompt: string, focus: string) => this.runDelegateSubtask(prompt, focus, options),
      mcpClients: this.mcp.getClients(),
      waitForCostApproval: (id: string) => this.broker.waitForCostApproval(id),
      skipMediaCostConfirmation: this.config.skipMediaCostConfirmation,
      immuneSystem: this.immuneSystem,
    };
  }

  get promptDeps(): PromptBuilderDeps {
    return {
      db: this.db,
      workspaceId: this.workspaceId,
      orchestratorModel: this.orchestratorModel,
      anthropicApiKey: this.anthropicApiKey,
      workingDirectory: this.workingDirectory,
      channels: this.channels,
      hasOrchestratorFileAccess: () => this.hasOrchestratorFileAccess(),
    };
  }

  constructor(
    db: DatabaseAdapter,
    engine: RuntimeEngine,
    workspaceId: string,
    anthropicApiKey: string,
    channels: ChannelRegistry,
    controlPlane?: ControlPlaneClient | null,
    modelRouter?: ModelRouter | null,
    scraplingService?: ScraplingService,
    orchestratorModel?: string,
    workingDirectory?: string,
    browserHeadless?: boolean,
    dataDir?: string,
    mcpServers?: McpServerConfig[],
    browserTarget?: 'chromium' | 'chrome',
    chromeCdpPort?: number,
    desktopToolsEnabled?: boolean,
  ) {
    this.db = db;
    this.engine = engine;
    this.workspaceId = workspaceId;
    this.anthropicApiKey = anthropicApiKey;
    // Support OpenRouter: when no Anthropic key but OpenRouter is configured,
    // use the Anthropic SDK with OpenRouter's base URL (API-compatible)
    const orKey = modelRouter?.getOpenRouterApiKey?.();
    if (anthropicApiKey) {
      this.anthropic = new Anthropic({ apiKey: anthropicApiKey, timeout: 120_000 });
    } else if (orKey) {
      this.anthropicApiKey = orKey; // allow getActiveModel() to return non-ollama
      this.anthropic = new Anthropic({
        apiKey: orKey,
        baseURL: 'https://openrouter.ai/api',
        timeout: 120_000,
      });
    } else {
      this.anthropic = new Anthropic({ apiKey: '', timeout: 120_000 });
    }
    this.channels = channels;
    this.controlPlane = controlPlane ?? null;
    this.modelRouter = modelRouter ?? null;
    this.scraplingService = scraplingService;
    this.orchestratorModel = orchestratorModel || '';
    this.workingDirectory = workingDirectory || '';
    this.browserHeadless = browserHeadless ?? false;
    this.browserTarget = browserTarget || 'chrome';
    this.chromeCdpPort = chromeCdpPort || 9222;
    this.dataDir = dataDir || '';
    this.config.desktopToolsEnabled = desktopToolsEnabled === true;
    this.broker = new PermissionBroker(this.db, this.workspaceId);
    this.mcp = new McpLifecycle(this.db, this.broker, () => this.syncOrganToBody(), mcpServers || []);

    // Initialize the unified Brain (philosophical cognitive coordinator)
    this.brain = new Brain({ modelRouter: this.modelRouter });

    // Lazy, non-blocking init of the 8 philosophical layers. Wires every
    // layer into BOTH this.brain (orchestrator chat) and this.engine's
    // brain (per-agent task execution) so chat tools reading
    // get_body_state from LocalToolContext see the same bpp state. P4.14
    // proprioception bench caught exactly this when the engine brain was
    // left empty.
    initPhilosophicalLayers(this.db, this.workspaceId, this.layers, this.brain, this.engine.getBrain());
  }

  /** Get the Brain instance (for external access if needed). */
  getBrain(): Brain | null {
    return this.brain;
  }

  /** Get BPP modules for external wiring (scheduler, health endpoint, etc.). */
  getBppModules(): {
    homeostasis: import('../homeostasis/homeostasis-controller.js').HomeostasisController | null;
    affect: import('../affect/affect-engine.js').AffectEngine | null;
    endocrine: import('../endocrine/endocrine-system.js').EndocrineSystem | null;
    immune: import('../immune/immune-system.js').ImmuneSystem | null;
    sleep: import('../oneiros/sleep-cycle.js').SleepCycle | null;
  } {
    return {
      homeostasis: this.homeostasisController,
      affect: this.affectEngine,
      endocrine: this.endocrineSystem,
      immune: this.immuneSystem,
      sleep: this.sleepCycle,
    };
  }

  /** Set the digital body for dynamic organ wiring. */
  setDigitalBody(body: DigitalBody): void {
    this.digitalBody = body;
    // Wire currently active organs
    if (this.browserService) this.digitalBody.setOrgan('browser', createBrowserOrgan(this.browserService));
    if (this.desktopService) this.digitalBody.setOrgan('desktop', createDesktopOrgan(this.desktopService));
  }

  /** Sync a newly activated service to the digital body. */
  syncOrganToBody(): void {
    if (!this.digitalBody) return;
    if (this.browserService) this.digitalBody.setOrgan('browser', createBrowserOrgan(this.browserService));
    else this.digitalBody.removeOrgan('browser');
    if (this.desktopService) this.digitalBody.setOrgan('desktop', createDesktopOrgan(this.desktopService));
    else this.digitalBody.removeOrgan('desktop');
    const mcpClients = this.mcp?.getClients();
    if (mcpClients) this.digitalBody.setOrgan('mcp', createMcpOrgan(mcpClients));
    else this.digitalBody.removeOrgan('mcp');
  }

  /** Get the active model name (resolved from Anthropic constant or orchestratorModel). */
  getActiveModel(): string {
    if (!this.anthropicApiKey) {
      return this.orchestratorModel || 'ollama';
    }
    return this.orchestratorModel || MODEL;
  }

  /** Set the orchestrator model at runtime. */
  setOrchestratorModel(model: string): void {
    this.orchestratorModel = model;
  }

  /** Set the model source at runtime (delegates to ModelRouter). */
  setModelSource(source: ModelSourceOption): void {
    this.modelRouter?.setModelSource(source);
  }

  /** Set which cloud provider to use when modelSource === 'cloud'. */
  setCloudProvider(provider: 'anthropic' | 'openrouter'): void {
    this.modelRouter?.setCloudProvider(provider);
  }

  /** Get the underlying ModelRouter (for provider access in API routes). */
  getModelRouter(): ModelRouter | null {
    return this.modelRouter;
  }

  /** Set whether to skip cost confirmation for cloud media tools. */
  setSkipMediaCostConfirmation(skip: boolean): void {
    this.config.setSkipMediaCostConfirmation(skip);
  }

  /** Set connector registry for data source sync. */
  setConnectorRegistry(registry: ConnectorRegistry): void {
    this.config.setConnectorRegistry(registry);
  }

  /** Set RAG embedding config (Ollama URL, models, weights). */
  setRagConfig(opts: RagConfigOptions): void {
    this.config.setRagConfig(opts);
  }

  /** Set Chrome profile aliases (email → profile directory) from config. */
  setChromeProfileAliases(aliases: Record<string, string>): void {
    this.config.setChromeProfileAliases(aliases);
    // Propagate to any already-constructed desktop service
    if (this.desktopService) {
      this.desktopService.setChromeProfileAliases(this.config.chromeProfileAliases);
    }
  }

  /** Set LSP manager for code intelligence tools. */
  setLspManager(manager: import('../lsp/lsp-manager.js').LspManager): void {
    this.config.setLspManager(manager);
  }

  /** Set the active meeting session for live audio capture. */
  setMeetingSession(session: import('../meeting/meeting-session.js').MeetingSession): void {
    this.config.setMeetingSession(session);
  }

  /** Set TurboQuant KV cache compression bits (0 = disabled, 2/3/4 = enabled). */
  setTurboQuantBits(bits: 0 | 2 | 3 | 4): void {
    this.config.setTurboQuantBits(bits);
  }

  /** Set confirmed inference capabilities (gates context inflation on turboQuantActive). */
  setInferenceCapabilities(caps: InferenceCapabilities): void {
    this.config.setInferenceCapabilities(caps);
  }

  /** Set the Anthropic API key at runtime (e.g. after user enters it in model picker). */
  setAnthropicApiKey(apiKey: string): void {
    this.anthropicApiKey = apiKey;
    this.anthropic = new Anthropic({ apiKey, timeout: 120_000 });
  }

  /** Close the persistent browser instance (call from orchestrator cleanup/shutdown). */
  async closeBrowser(): Promise<void> {
    if (this.browserService) {
      logger.debug('[browser] closeBrowser() called — closing browser process');
      await this.browserService.close().catch(() => {});
      this.browserService = null;
      this.browserActivated = false;
      this.syncOrganToBody();
    }
  }

  /** Close the desktop control service (call from orchestrator cleanup/shutdown). */
  async closeDesktop(): Promise<void> {
    if (this.desktopService) {
      logger.debug('[desktop] closeDesktop() called — closing desktop service');
      await this.desktopService.close();
      this.desktopService = null;
      this.desktopActivated = false;
      this.syncOrganToBody();
    }
  }

  /** Close MCP client connections (call alongside browser cleanup on shutdown). */
  async closeMcp(): Promise<void> {
    await this.mcp.close();
  }

  /**
   * Reload the MCP server registry from the per-workspace DB and reconnect.
   * Called by the typed `ohwow_add_mcp_server` / `ohwow_remove_mcp_server`
   * tools (via POST /api/mcp/servers) so newly registered servers are live
   * without a daemon restart.
   */
  async reloadMcpServers(): Promise<void> {
    await this.mcp.reload();
  }

  async ensureMcpConnected(force = false): Promise<void> {
    await this.mcp.ensureConnected(force);
  }

  /**
   * Snapshot of the most recent MCP reload outcome. Daemon health checks
   * and POST /api/mcp/servers callers read this to verify a reload
   * actually populated tools, not just that the API call succeeded.
   */
  getMcpStatus(): McpReloadStatus | null {
    return this.mcp.getStatus();
  }

  /** Resolve a pending MCP elicitation request. */
  resolveElicitation(requestId: string, response: Record<string, unknown> | null): void {
    this.broker.resolveElicitation(requestId, response);
  }

  /** Set the schedule change callback for notifying the scheduler on CRUD. */
  setScheduleChangeCallback(callback: () => void): void {
    this.config.setScheduleChangeCallback(callback);
  }

  /** Resolve a pending permission request. Called by the API route. */
  resolvePermission(requestId: string, granted: boolean): void {
    this.broker.resolvePermission(requestId, granted);
  }

  /** Resolve a pending cost approval request. Called by the API route. */
  resolveCostApproval(requestId: string, approved: boolean): void {
    this.broker.resolveCostApproval(requestId, approved);
  }

  /**
   * Chat with the orchestrator. Yields events for streaming UI (TUI).
   * When seedMessages is provided (cloud proxy path), uses those instead of loadHistory().
   *
   * `turn` is the per-call config snapshot — model override, model source,
   * chat actor attribution, persona hint, trace id. Passed by the route
   * handler instead of mutating instance state via setOrchestratorModel /
   * setChatActor / setModelSource setters that would race with concurrent
   * dispatches. Bug #6 fix.
   */
  async *chat(
    userMessage: string,
    sessionId: string,
    seedMessages?: MessageParam[],
    turn?: ChatTurnOptions,
  ): AsyncGenerator<OrchestratorEvent> {
    yield* this.runChat(userMessage, sessionId, turn?.channel, seedMessages, turn);
  }

  /**
   * Chat for a messaging channel (non-streaming). Collects full response.
   */
  async chatForChannel(
    userMessage: string,
    sessionId: string,
    options: ChannelChatOptions,
  ): Promise<string> {
    let fullContent = '';
    for await (const event of this.runChat(userMessage, sessionId, options)) {
      if (event.type === 'text') {
        fullContent += event.content;
      }
    }
    return fullContent;
  }

  // ==========================================================================
  // CORE CHAT LOOP
  // ==========================================================================

  async *runChat(
    userMessage: string,
    sessionId: string,
    options?: ChannelChatOptions,
    seedMessages?: MessageParam[],
    turn?: ChatTurnOptions,
  ): AsyncGenerator<OrchestratorEvent> {
    // Per-turn config snapshot (bug #6 fix). When the route handler passes
    // explicit `turn` options, prefer them over instance fields. The instance
    // setters (setOrchestratorModel, setChatActor, setModelSource) stay in
    // place as the legacy fallback for callers that haven't migrated.
    const effectiveModel = (turn?.orchestratorModel?.trim()) || this.orchestratorModel;

    // Per-chat structured logger (bug #6 fix 6d). Every log line in this
    // turn carries chatTraceId so a future hang can be diagnosed with one
    // grep against the daemon log instead of correlating timestamps by hand.
    // Falls back to the first 8 chars of sessionId when no explicit trace
    // id was passed (e.g. legacy callers via the SSE path).
    const chatTraceId = turn?.chatTraceId ?? sessionId.slice(0, 8);
    const chatLog = logger.child({ chatTraceId });
    chatLog.debug({ effectiveModel, hasSeed: !!seedMessages }, '[orchestrator] chat turn entry');

    // Lazily connect MCP servers on first chat
    await this.ensureMcpConnected();

    // Route via ModelRouter when available — respects modelSource (local/cloud/auto)
    if (this.modelRouter) {
      let provider: ModelProvider;
      try {
        // BPP-aware model selection: use brain confidence + endocrine state
        // + recent prediction accuracy when available. Shape C wired the
        // experience stream's accuracy signal into the routing decision so
        // the router can escalate to a more capable model when the brain
        // has been wrong about tool outcomes lately.
        if (this.brain || this.endocrineSystem) {
          // 60-second window: recent enough to reflect current session
          // performance, wide enough to smooth out single-call noise.
          const RECENT_ACCURACY_WINDOW_MS = 60_000;
          const recentPredictionAccuracy = this.brain
            ? this.brain.experienceStream.getPredictionAccuracy(RECENT_ACCURACY_WINDOW_MS)
            : undefined;
          provider = await this.modelRouter.selectModelWithContext('orchestrator', {
            selfModelConfidence: this.brain?.predictiveEngine?.getToolSuccessRate('orchestrator'),
            endocrineEffects: this.endocrineSystem?.getEffects(),
            recentPredictionAccuracy,
            operationType: 'orchestrator_chat',
          });
        } else {
          provider = await this.modelRouter.getProvider('orchestrator');
        }
      } catch {
        yield { type: 'text', content: "No model available. Go to Settings → press **o** to set up a model." };
        yield { type: 'done', inputTokens: 0, outputTokens: 0 };
        return;
      }

      // Silent fallback guard: if the user chose a local model but Ollama was
      // unreachable, getProvider() silently falls back to Anthropic. Detect this
      // and surface a clear error instead of burning cloud credits.
      if (provider.name === 'anthropic' && effectiveModel && !effectiveModel.startsWith('claude-')) {
        yield { type: 'text', content: "Ollama isn't reachable. Make sure it's running, or switch to a cloud model with **Ctrl+O**." };
        yield { type: 'done', inputTokens: 0, outputTokens: 0 };
        return;
      }

      // Ollama provider → use the Ollama tool loop (or text-only fallback)
      if (provider.name === 'ollama') {
        if (provider.createMessageWithTools) {
          yield* runOllamaChat.call(this, userMessage, sessionId, provider as ModelProvider & { createMessageWithTools: NonNullable<ModelProvider['createMessageWithTools']> }, options, seedMessages, turn);
        } else {
          const textParamTier = getParameterTier(effectiveModel || '');
          const textPromptMode: boolean | 'micro' = textParamTier === 'micro' ? 'micro' : textParamTier === 'small' ? true : false;
          let { staticPart, dynamicPart } = await buildFullPrompt(this.promptDeps, userMessage, textPromptMode || undefined);
          let systemPrompt = staticPart + '\n\n' + dynamicPart;
          const device = detectDevice();
          const tqBits = this.config.getTurboQuantTierBits();
          const numCtx = getWorkingNumCtx(effectiveModel || '', undefined, device, tqBits);
          const budget = new ContextBudget(numCtx, 4096);
          budget.setSystemPrompt(systemPrompt);

          // Switch to compact prompt if context is still tight (no tools in text-only path)
          if (!textPromptMode && budget.isTight(2000)) {
            const compact = await buildFullPrompt(this.promptDeps, userMessage, true);
            staticPart = compact.staticPart;
            dynamicPart = compact.dynamicPart;
            systemPrompt = staticPart + '\n\n' + dynamicPart;
            budget.setSystemPrompt(systemPrompt);
            logger.debug(`[orchestrator] Text-only: switched to compact prompt (${budget.getState().systemPromptTokens} tokens)`);
          }

          // Body Awareness for text-only Ollama path
          const textProprio = this.brain?.getProprioception();
          if (textProprio && textProprio.organs.length > 0) {
            const activeOrgans = textProprio.organs.filter(o => o.health !== 'dormant');
            if (activeOrgans.length > 0) {
              systemPrompt += `\n\n## Body Awareness\nActive capabilities: ${activeOrgans.map(o => `${o.name} (${o.health})`).join(', ')}`;
            }
          }

          const history = seedMessages ? [...seedMessages] : await loadHistory(this.sessionDeps, sessionId);
          history.push({ role: 'user', content: userMessage });

          const modelMessages = history.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          }));
          const trimmedMessages = budget.trimToFit(modelMessages);
          const budgetState = budget.getState();
          logger.debug(`[orchestrator] Context budget (text-only): ${budgetState.utilizationPct}% used | sys:${budgetState.systemPromptTokens} hist:${budgetState.historyTokens} msgs:${budgetState.messageCount} | capacity:${budgetState.modelCapacity} available:${budgetState.availableTokens}`);

          if (provider instanceof OllamaProvider) {
            // Stream tokens incrementally. createTimeoutController gives the
            // stream an abort signal so a hung upstream API can't lock the
            // for-await iterator forever (bug #6 fix).
            const thinkFilter = new ThinkTagFilter();
            const streamTimer = createTimeoutController(
              `provider.createMessageStreaming (${provider.name}, ${effectiveModel || 'default'})`,
              MODEL_CALL_TIMEOUT_MS,
            );
            const streamParams = {
              system: systemPrompt,
              messages: trimmedMessages,
              maxTokens: 4096,
              temperature: 0.5,
              numCtx,
              signal: streamTimer.signal,
            };
            let resp: ModelResponse;
            try {
              const stream = provider.createMessageStreaming(streamParams);
              let streamResult: IteratorResult<{ type: 'token'; content: string }, ModelResponse>;
              let finalResponse: ModelResponse | undefined;
              while (true) {
                streamResult = await stream.next();
                if (streamResult.done) {
                  finalResponse = streamResult.value;
                  break;
                }
                const filtered = thinkFilter.feed(streamResult.value.content);
                if (filtered) {
                  yield { type: 'text', content: filtered };
                }
              }
              const flushed = thinkFilter.flush();
              if (flushed) {
                yield { type: 'text', content: flushed };
              }
              resp = finalResponse!;
            } finally {
              streamTimer.cancel();
            }
            await saveToSession(this.sessionDeps, sessionId, [
              { role: 'user', content: userMessage },
              { role: 'assistant', content: stripThinkTags(resp.content) },
            ], userMessage.slice(0, 100));
            this.exchangeCount++;
            yield { type: 'done', inputTokens: resp.inputTokens, outputTokens: resp.outputTokens };
          } else {
            // Wrapped in withTimeout (bug #6 fix).
            const response = await withTimeout(
              `provider.createMessage (${provider.name}, ${effectiveModel || 'default'}, text-only)`,
              MODEL_CALL_TIMEOUT_MS,
              (signal) => provider.createMessage({
                system: systemPrompt,
                messages: trimmedMessages,
                maxTokens: 4096,
                temperature: 0.5,
                numCtx,
                signal,
              }),
            );
            yield { type: 'text', content: response.content };
            await saveToSession(this.sessionDeps, sessionId, [
              { role: 'user', content: userMessage },
              { role: 'assistant', content: response.content },
            ], userMessage.slice(0, 100));
            this.exchangeCount++;
            yield { type: 'done', inputTokens: response.inputTokens, outputTokens: response.outputTokens };
          }
        }
        return;
      }

      // OpenRouter provider → dedicated tool loop with native OpenAI format + streaming
      if (provider.name === 'openrouter' && provider instanceof OpenRouterProvider) {
        yield* runOpenRouterChat.call(this, userMessage, sessionId, provider, options, seedMessages, turn);
        return;
      }
      // Anthropic provider → fall through to the full Anthropic SDK path below
    }

    yield* runAnthropicChat.call(this, userMessage, sessionId, options, seedMessages, turn, effectiveModel);
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /** Run a sub-orchestrator for delegate_subtask tool calls. */
  async runDelegateSubtask(prompt: string, focus: string, options?: ChannelChatOptions, depth = 0): Promise<SubOrchestratorResult> {
    // Per-focus iteration budgets. Janitorial work (wiki cleanup) needs
    // headroom to walk a backlog of lint findings — one read+write pair
    // per finding, plus the bracketing lint calls. Investigations get a
    // similar boost because bisection rounds add up: expand → 5 search
    // calls → 5 reads → bisect each hypothesis → conclude. The default
    // 5 caps out before any of that lands. The 6 min timeout in
    // FOCUS_TIMEOUTS_MS is the matching ceiling.
    const focusIterations: Record<string, number> = {
      wiki: 18,
      investigate: 15,
    };
    return runSubOrchestrator({
      prompt,
      sections: getFocusSections(focus),
      parentToolCtx: this.buildToolCtx(),
      modelRouter: this.modelRouter,
      anthropic: this.anthropic,
      anthropicApiKey: this.anthropicApiKey,
      orchestratorModel: this.orchestratorModel,
      circuitBreaker: this.circuitBreaker,
      toolCache: this.toolCache,
      options,
      depth,
      maxIterations: focusIterations[focus],
      timeoutMs: getTimeoutForFocus(focus),
      focus,
    });
  }

  /** Check if the orchestrator has file access paths configured. */
  async hasOrchestratorFileAccess(): Promise<boolean> {
    const { count } = await this.db
      .from('agent_file_access_paths')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', '__orchestrator__')
      .eq('workspace_id', this.workspaceId);
    return (count || 0) > 0;
  }

  /**
   * Build the full tool list, conditionally including filesystem tools.
   * When `sections` is provided, filters tools to only those relevant to the intent.
   */
  async getTools(
    options?: ChannelChatOptions,
    browserPreActivated?: boolean,
    sections?: Set<IntentSection>,
    desktopPreActivated?: boolean,
    maxPriority?: 1 | 2 | 3,
    userMessageForToolExtraction?: string,
  ): Promise<Tool[]> {
    return assembleOrchestratorToolSurface({
      excludedTools: options?.excludedTools,
      browserPreActivated,
      browserActivated: this.browserActivated,
      desktopPreActivated,
      desktopActivated: this.desktopActivated,
      desktopToolsEnabled: this.config.desktopToolsEnabled,
      filesystemActivated: this.filesystemActivated,
      hasOrchestratorFileAccess: () => this.hasOrchestratorFileAccess(),
      mcpTools: this.mcp.getToolDefinitions(),
      mcpServerCount: this.mcp.getServerCount(),
      sections,
      maxPriority,
      userMessageForToolExtraction,
    });
  }

  // trackSkillUsage() removed in the skill-unification refactor —
  // see /Users/jesus/.claude/plans/idempotent-tumbling-flame.md.
  // Used to update an EMA rolling-average success_rate on
  // `skill_type='procedure'` rows whenever the executed tool list
  // happened to contain a procedure's full tool_sequence. Never ran
  // for any non-degenerate skill (all active procedure skills had
  // single-tool tool_sequences, and the threshold was `length >= 3`,
  // so the hot path was actually unreachable in practice). Code
  // skills use runtime-skill-metrics.ts on every tool dispatch.


}
