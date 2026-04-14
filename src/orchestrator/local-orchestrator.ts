/**
 * Local Orchestrator
 * Conversational AI assistant for the local TUI runtime.
 * Uses async generator for streaming events (not SSE like the web version).
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  TextBlock,
  TextBlockParam,
  ContentBlock,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import { CLAUDE_CONTEXT_LIMITS } from '../execution/ai-types.js';
import { ORCHESTRATOR_TOOL_DEFINITIONS, LSP_TOOL_DEFINITIONS, COS_EXTENSION_TOOL_DEFINITIONS, FILESYSTEM_TOOL_DEFINITIONS, BASH_TOOL_DEFINITIONS, REQUEST_FILE_ACCESS_TOOL, filterToolsByIntent, extractExplicitToolNames, getToolPriorityLimit, type IntentSection } from './tool-definitions.js';
import { runtimeToolRegistry } from './runtime-tool-registry.js';
import { loadConversationPersona } from './conversation-persona.js';
import { invalidateFileAccessCache } from './tools/filesystem.js';
import { invalidateBashAccessCache } from './tools/bash.js';
import { FILE_ACCESS_ACTIVATION_MESSAGE } from '../execution/filesystem/index.js';
import { getWorkingNumCtx, MODEL_CATALOG, getParameterTier } from '../lib/ollama-models.js';
import { detectDevice } from '../lib/device-info.js';
import { ContextBudget, estimateTokens, estimateToolTokens } from './context-budget.js';
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
import type { ControlPlaneClient } from '../control-plane/client.js';
import { type ModelRouter, type ModelResponse, type ModelResponseWithTools, type ModelProvider, type ModelSourceOption, OllamaProvider, OpenRouterProvider } from '../execution/model-router.js';
import { convertToolsToOpenAI, compressToolsForContext } from '../execution/tool-format.js';
import { parseToolArguments } from '../execution/tool-parse.js';
import { repairToolCall } from './tool-call-repair.js';
import { extractToolCallsFromText } from '../execution/text-tool-parse.js';
import type { ScraplingService } from '../execution/scrapling/index.js';
import type { McpServerConfig } from '../mcp/types.js';
import {
  REQUEST_BROWSER_TOOL,
  LIST_CHROME_PROFILES_TOOL,
  BROWSER_TOOL_DEFINITIONS,
} from '../execution/browser/browser-tools.js';
import { LocalBrowserService } from '../execution/browser/local-browser.service.js';
import {
  REQUEST_DESKTOP_TOOL,
  DESKTOP_TOOL_DEFINITIONS,
} from '../execution/desktop/desktop-tools.js';
import { LocalDesktopService } from '../execution/desktop/local-desktop.service.js';
import { buildDisplayLayout } from '../execution/desktop/screenshot-capture.js';
import {
  type OrchestratorEvent,
  type ClassifiedIntent,
  type ChannelChatOptions,
  MODEL,
  MAX_ITERATIONS,
  MODE_MAX_ITERATIONS,
  stripThinkTags,
  ThinkTagFilter,
} from './orchestrator-types.js';
import { buildReflectionPrompt } from './reflection.js';
import { classifyIntent } from './intent-classifier.js';
import {
  loadHistory,
  saveToSession,
  persistExchange,
  buildAnthropicTurnMessages,
  buildOllamaTurnMessages,
  extractOrchestratorMemory,
  type OllamaMessage,
  type SessionDeps,
  type MemoryExtractionDeps,
} from './session-store.js';
import { reflectOnWikiOpportunities } from './wiki-reflector.js';
import { extractGoalCheckpoints, loadActiveGoals, formatGoalsForPrompt, type GoalCheckpointDeps } from './goal-checkpoints.js';
import {
  compactStaleToolResults,
  compactStaleOpenAIToolResults,
  checkTurnTokenBudget,
  estimateMessagesTokens,
  buildBudgetExitMessage,
} from './turn-context-guard.js';
import {
  buildTargetedPrompt,
  buildFullPrompt,
  type PromptBuilderDeps,
} from './prompt-builder.js';
import {
  executeToolCall,
  type ToolCallRequest,
  type BrowserState,
  type DesktopState,
  type ToolExecutionContext,
} from './tool-executor.js';
import { executeToolCallsBatch } from './batch-executor.js';
import { CircuitBreaker, ConsecutiveToolBreaker } from './error-recovery.js';
import { ToolCache } from './tool-cache.js';
import { runSubOrchestrator, getFocusSections, getTimeoutForFocus, type SubOrchestratorResult } from './sub-orchestrator.js';
import { logger } from '../lib/logger.js';
import { withTimeout, createTimeoutController, TimeoutError } from '../lib/with-timeout.js';

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
import { hashToolCall } from '../lib/stagnation.js';
import { Brain } from '../brain/brain.js';
import { enrichIntent } from '../brain/intentionality.js';
import type { Stimulus, Perception, WorkspaceItem } from '../brain/types.js';
import type { SelfModelDeps } from '../brain/self-model.js';
import { createBrowserOrgan, createDesktopOrgan, createMcpOrgan, type DigitalBody } from '../body/digital-body.js';
import { BodyStateService } from '../body/body-state.js';
import { Soul } from '../persona/soul.js';
import crypto from 'crypto';

export type { OrchestratorEvent, ChannelChatOptions } from './orchestrator-types.js';
export type { IntentSection } from './tool-definitions.js';

export class LocalOrchestrator {
  private anthropic: Anthropic;
  private db: DatabaseAdapter;
  private engine: RuntimeEngine;
  private workspaceId: string;
  private channels: ChannelRegistry;
  private controlPlane: ControlPlaneClient | null;
  private modelRouter: ModelRouter | null;
  private scraplingService: ScraplingService | undefined;
  private anthropicApiKey: string;
  private orchestratorModel: string;
  private workingDirectory: string;
  private browserHeadless: boolean;
  private browserTarget: 'chromium' | 'chrome';
  private chromeCdpPort: number;
  private dataDir: string;
  private browserService: LocalBrowserService | null = null;
  private browserActivated = false;
  private browserRequestedProfile: string | undefined;
  /**
   * Non-null when the most recent browser activation fell through from
   * CDP-attached mode to an isolated bundled Chromium. Tool executors
   * read this via `getBrowserDegradedReason()` and surface it to the
   * LLM so the next turn stops assuming a logged-in session.
   */
  private _browserDegradedReason: string | null = null;
  private desktopService: LocalDesktopService | null = null;
  private desktopActivated = false;
  private filesystemActivated = false;
  private config = new OrchestratorRuntimeConfig();
  private broker: PermissionBroker;
  private exchangeCount = 0;
  private lastIntentBySession = new Map<string, ClassifiedIntent>();
  private circuitBreaker = new CircuitBreaker();
  private toolCache = new ToolCache();
  private mcp!: McpLifecycle;
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
  private brain: Brain | null = null;
  /** Soul: deep human persona awareness (Aristotle's Psyche). */
  private soul = new Soul();
  /** Digital Body: the agent's embodied capabilities (Merleau-Ponty). */
  private digitalBody: DigitalBody | null = null;
  /** Body State Service: unified system health reporting. */
  private bodyStateService: BodyStateService | null = null;

  // Philosophical layers — lazy, non-blocking init. All 8 populate
  // asynchronously via initPhilosophicalLayers (helpers/fire-and-forget).
  private layers: PhilosophicalLayers = createEmptyPhilosophicalLayers();
  private get affectEngine() { return this.layers.affectEngine; }
  private get endocrineSystem() { return this.layers.endocrineSystem; }
  private get homeostasisController() { return this.layers.homeostasisController; }
  private get immuneSystem() { return this.layers.immuneSystem; }
  private get narrativeEngine() { return this.layers.narrativeEngine; }
  private get ethicsEngine() { return this.layers.ethicsEngine; }
  private get habitEngine() { return this.layers.habitEngine; }
  private get sleepCycle() { return this.layers.sleepCycle; }

  private get sessionDeps(): SessionDeps {
    return { db: this.db, workspaceId: this.workspaceId };
  }

  private get memoryDeps(): MemoryExtractionDeps {
    return { db: this.db, workspaceId: this.workspaceId, anthropicApiKey: this.anthropicApiKey, anthropic: this.anthropic, modelRouter: this.modelRouter };
  }

  private get browserState(): BrowserState {
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

  /** Activate browser — connects to real Chrome via CDP or launches Chromium */
  private async activateBrowser(requestedProfile?: string): Promise<void> {
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

  private get desktopState(): DesktopState {
    return { service: this.desktopService, activated: this.desktopActivated, dataDir: this.dataDir };
  }

  private buildToolCtx(sessionId?: string): LocalToolContext {
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
      // agent id on the orchestrator instance so they propagate into
      // every tool ctx the turn produces. Used by the deliverables
      // recorder to attribute artifacts to the right member + actor.
      currentTeamMemberId: this._chatActorTeamMemberId,
      currentGuideAgentId: this._chatActorGuideAgentId,
    };
  }

  /**
   * Stash the current chat actor (the team_member the runtime is
   * chatting on behalf of, plus their guide agent). Set by the
   * /api/chat handler before invoking orchestrator.chat() and cleared
   * after the turn completes. Lives on the instance instead of the
   * chat() method signature because the tool ctx builder is called
   * from many code paths inside the iteration loop and we don't want
   * to thread a new arg through every one.
   */
  setChatActor(actor: { teamMemberId: string | null; guideAgentId: string | null } | null): void {
    this._chatActorTeamMemberId = actor?.teamMemberId ?? undefined;
    this._chatActorGuideAgentId = actor?.guideAgentId ?? undefined;
  }
  private _chatActorTeamMemberId?: string;
  private _chatActorGuideAgentId?: string;

  private buildToolExecCtx(executedToolCalls: Map<string, ToolResult>, options?: ChannelChatOptions, sessionId?: string): ToolExecutionContext {
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

  private get promptDeps(): PromptBuilderDeps {
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
  private syncOrganToBody(): void {
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

  private async ensureMcpConnected(force = false): Promise<void> {
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
   */
  async *chat(
    userMessage: string,
    sessionId: string,
    seedMessages?: MessageParam[],
  ): AsyncGenerator<OrchestratorEvent> {
    yield* this.runChat(userMessage, sessionId, undefined, seedMessages);
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

  private async *runChat(
    userMessage: string,
    sessionId: string,
    options?: ChannelChatOptions,
    seedMessages?: MessageParam[],
  ): AsyncGenerator<OrchestratorEvent> {
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
      if (provider.name === 'anthropic' && this.orchestratorModel && !this.orchestratorModel.startsWith('claude-')) {
        yield { type: 'text', content: "Ollama isn't reachable. Make sure it's running, or switch to a cloud model with **Ctrl+O**." };
        yield { type: 'done', inputTokens: 0, outputTokens: 0 };
        return;
      }

      // Ollama provider → use the Ollama tool loop (or text-only fallback)
      if (provider.name === 'ollama') {
        if (provider.createMessageWithTools) {
          yield* this.runOllamaToolLoop(userMessage, sessionId, provider as ModelProvider & { createMessageWithTools: NonNullable<ModelProvider['createMessageWithTools']> }, options, seedMessages);
        } else {
          const textParamTier = getParameterTier(this.orchestratorModel || '');
          const textPromptMode: boolean | 'micro' = textParamTier === 'micro' ? 'micro' : textParamTier === 'small' ? true : false;
          let { staticPart, dynamicPart } = await buildFullPrompt(this.promptDeps, userMessage, textPromptMode || undefined);
          let systemPrompt = staticPart + '\n\n' + dynamicPart;
          const device = detectDevice();
          const tqBits = this.config.getTurboQuantTierBits();
          const numCtx = getWorkingNumCtx(this.orchestratorModel || '', undefined, device, tqBits);
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
              `provider.createMessageStreaming (${provider.name}, ${this.orchestratorModel || 'default'})`,
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
              `provider.createMessage (${provider.name}, ${this.orchestratorModel || 'default'}, text-only)`,
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
        yield* this.runOpenRouterToolLoop(userMessage, sessionId, provider, options, seedMessages);
        return;
      }
      // Anthropic provider → fall through to the full Anthropic SDK path below
    }

    // Generate trace ID for this orchestrator turn
    const traceId = crypto.randomUUID();

    // Classify intent, inheriting previous intent for confirmations
    const previousIntent = this.lastIntentBySession.get(sessionId);
    const classified = classifyIntent(userMessage, previousIntent);

    // PERCEIVE: Full cognitive cycle entry point (Husserl's intentionality)
    // Brain.perceive() enriches intent with horizons, builds temporal frame, and self-model
    let perception: Perception | null = null;
    if (this.brain) {
      const isVoice = options?.platform === 'voice';
      const stimulus: Stimulus = {
        type: isVoice ? 'auditory_input' : 'user_message',
        content: userMessage,
        source: isVoice ? 'voice' : 'orchestrator',
        timestamp: Date.now(),
        voiceContext: options?.voiceContext ? {
          sttConfidence: options.voiceContext.sttConfidence,
          sttProvider: options.voiceContext.sttProvider,
          language: options.voiceContext.language,
          durationMs: options.voiceContext.audioDurationMs,
        } : undefined,
      };
      const selfModelDeps: SelfModelDeps = {
        activeModel: this.getActiveModel(),
        modelCapabilities: this.anthropicApiKey ? ['tool_calling'] : [],
        tokenBudgetRemaining: 4096,
        limitations: this.anthropicApiKey ? [] : ['ollama_only'],
        currentLoad: 0,
        bodyProprioception: this.brain?.getProprioception(),
      };
      perception = this.brain.perceive(stimulus, classified, selfModelDeps);
    }
    // Use perception's enriched intent, or fall back to standalone enrichment
    const enriched = perception?.intent ?? enrichIntent(classified, userMessage);
    const { sections, statusLabel } = enriched;
    yield { type: 'status', message: statusLabel };

    // Store for next turn (so confirmations can inherit)
    this.lastIntentBySession.set(sessionId, enriched);

    // Auto-activate browser when intent is 'browser' (skip the two-step gateway)
    const browserPreActivated = sections.has('browser') && classified.intent === 'browser';
    // Reuse existing browser from previous turn if still active
    if (this.browserService && !this.browserService.isActive()) {
      yield { type: 'status', message: '[debug] Browser process died, will relaunch if needed' };
      logger.debug('[browser] Browser process no longer active — nullifying');
      this.browserService = null;
      this.browserActivated = false;
      this.syncOrganToBody();
    }
    if (browserPreActivated && !this.browserActivated) {
      logger.debug(`[browser] Pre-activating browser — target: ${this.browserTarget}`);
      await this.activateBrowser();
    }

    // Auto-activate desktop when intent is 'desktop'
    const desktopPreActivated = sections.has('desktop') && classified.intent === 'desktop';
    if (desktopPreActivated && !this.desktopActivated) {
      yield { type: 'status', message: '[debug] Desktop control launching (pre-activation)' };
      logger.debug('[desktop] Pre-activating desktop control');
      this.desktopService = new LocalDesktopService({ chromeProfileAliases: this.config.chromeProfileAliases });
      this.desktopActivated = true;
      this.syncOrganToBody();
    }

    // Build targeted system prompt (only fetches context for relevant sections)
    const desktopDisplayLayout = this.desktopService ? buildDisplayLayout(this.desktopService.getScreenInfo().displays) : undefined;
    const hasMcpTools = this.mcp.hasTools();
    const mcpServerNames = hasMcpTools ? this.mcp.getServerNames() : undefined;
    const { staticPart, dynamicPart } = await buildTargetedPrompt(this.promptDeps, userMessage, sections, browserPreActivated || this.browserActivated, options?.platform, desktopPreActivated || this.desktopActivated, undefined, desktopDisplayLayout, hasMcpTools, mcpServerNames);

    // Array format: static block is cached, dynamic block changes each call
    const systemBlocks: TextBlockParam[] = [
      {
        type: 'text' as const,
        text: staticPart,
        cache_control: { type: 'ephemeral' as const },
      },
      {
        type: 'text' as const,
        text: dynamicPart,
      },
    ];

    // Persona: inject behavioral context into system prompt (Aristotle's Psyche)
    const personaContext = this.soul.buildPromptContext();
    if (personaContext) {
      systemBlocks.push({ type: 'text' as const, text: `\n\n## Human Awareness\n${personaContext}` });
    }

    // Observe this interaction for persona learning
    this.soul.observer.observe({ type: 'message_sent', timestamp: Date.now(), metadata: { wordCount: userMessage.split(/\s+/).length, sessionId } });

    // True Soul: inject identity-level context (Plato's Tripartite + Jung's Shadow)
    // Periodically persist soul snapshots for cross-session continuity
    try {
      const { TrueSoul } = await import('../soul/soul.js');
      const trueSoul = new TrueSoul();
      const soulContext = trueSoul.buildPromptContext();
      if (soulContext) {
        systemBlocks.push({ type: 'text' as const, text: `\n\n## Soul Awareness\n${soulContext}` });
      }
      // Persist soul snapshot every ~50 exchanges (fire-and-forget)
      if (soulContext && this.exchangeCount > 0 && this.exchangeCount % 50 === 0 && this.db) {
        this.db.from('soul_snapshots').insert({
          workspace_id: this.workspaceId,
          agent_id: this.workspaceId,
          soul: JSON.stringify({ promptContext: soulContext }),
          confidence: 0.5,
          emerging_identity: soulContext.slice(0, 200),
        }).then(() => {}, () => { /* table may not exist yet */ });
      }
    } catch { /* non-fatal: soul is best-effort enrichment */ }

    // Body Awareness: inject proprioceptive context (Merleau-Ponty: embodied self-knowledge)
    const proprioception = this.brain?.getProprioception();
    const bodyLines: string[] = [];

    if (proprioception && proprioception.organs.length > 0) {
      const activeOrgans = proprioception.organs.filter(o => o.health !== 'dormant');
      const degraded = activeOrgans.filter(o => o.health === 'degraded' || o.health === 'failed');
      const affordances = proprioception.affordances.filter(a => a.readiness > 0.5);

      if (activeOrgans.length > 0) {
        bodyLines.push(`Active capabilities: ${activeOrgans.map(o => `${o.name} (${o.health})`).join(', ')}`);
      }
      if (degraded.length > 0) {
        bodyLines.push(`Degraded: ${degraded.map(o => `${o.name} is ${o.health}`).join(', ')}`);
      }
      if (affordances.length > 0) {
        bodyLines.push(`Available actions: ${affordances.map(a => a.action).join(', ')}`);
      }
    }

    // Enrich with body state service (pipeline, memory pressure, failures)
    try {
      if (!this.bodyStateService) {
        this.bodyStateService = new BodyStateService(this.db, this.workspaceId, this.digitalBody ?? undefined);
      }
      const summary = await this.bodyStateService.getProprioceptiveSummary();
      if (summary) {
        bodyLines.push(summary);
      }
    } catch { /* non-fatal */ }

    if (bodyLines.length > 0) {
      systemBlocks.push({ type: 'text' as const, text: `\n\n## Body Awareness\n${bodyLines.join('\n')}` });
    }

    // System Warnings: surface high-salience nervous signals (Baars: conscious items)
    const healthWarnings = this.brain?.workspace.getConscious(3, {
      types: ['failure', 'warning'],
      minSalience: 0.5,
    }) ?? [];
    if (healthWarnings.length > 0) {
      const warningText = healthWarnings.map(w => w.content).join('\n');
      systemBlocks.push({ type: 'text' as const, text: `\n\n## System Warnings\n${warningText}` });
    }

    // ---- PHILOSOPHICAL LAYERS: Only injected for large-context models ----
    // Claude models and unspecified models (defaults) have 100K+ context.
    // Small local models routed through Anthropic SDK shim may not.
    const hasAbundantContext = !this.orchestratorModel ||
      this.orchestratorModel.startsWith('claude-') ||
      (CLAUDE_CONTEXT_LIMITS[this.orchestratorModel as keyof typeof CLAUDE_CONTEXT_LIMITS] ?? 0) > 100_000;

    if (hasAbundantContext) {
      // Emotional Context (Damasio's somatic markers)
      const affectContext = this.affectEngine?.buildPromptContext();
      if (affectContext) {
        systemBlocks.push({ type: 'text' as const, text: `\n\n## Emotional Context\n${affectContext}` });
      }

      // Internal State (Spinoza's endocrine integration bus)
      const endocrineContext = this.endocrineSystem?.buildPromptContext();
      if (endocrineContext) {
        systemBlocks.push({ type: 'text' as const, text: `\n\n## Internal State\n${endocrineContext}` });
      }

      // Self-Regulation (Cannon's homeostasis — only when corrective actions active)
      const homeostasisContext = this.homeostasisController?.buildPromptContext();
      if (homeostasisContext) {
        systemBlocks.push({ type: 'text' as const, text: `\n\n## Self-Regulation\n${homeostasisContext}` });
      }

      // Security Alert (Maturana & Varela's immune system — only during elevated+ alert)
      const immuneContext = this.immuneSystem?.buildPromptContext();
      if (immuneContext) {
        systemBlocks.push({ type: 'text' as const, text: `\n\n## Security Alert\n${immuneContext}` });
      }

      // Your Story (Ricoeur's narrative identity)
      const narrativeContext = this.narrativeEngine?.buildPromptContext();
      if (narrativeContext) {
        systemBlocks.push({ type: 'text' as const, text: `\n\n## Your Story\n${narrativeContext}` });
      }

      // Ethical Awareness (Aristotle + Kant — only when constraints or dilemma active)
      const ethicsContext = this.ethicsEngine?.buildPromptContext(null);
      if (ethicsContext) {
        systemBlocks.push({ type: 'text' as const, text: `\n\n## Ethical Awareness\n${ethicsContext}` });
      }

      // Available Shortcuts (Aristotle's hexis — habit-based shortcuts)
      if (this.habitEngine) {
        const habitMatches = this.habitEngine.checkCues(userMessage, []);
        if (habitMatches.length > 0) {
          const shortcutText = habitMatches.slice(0, 3).map(m => m.suggestedShortcut).join('\n');
          systemBlocks.push({ type: 'text' as const, text: `\n\n## Available Shortcuts\n${shortcutText}` });
        }
      }

      // Subconscious Insights (Oneiros — recent dream discoveries)
      if (this.sleepCycle && !this.sleepCycle.isAsleep()) {
        const dreamInsights = this.brain?.workspace.getConscious(2, {
          types: ['dream' as WorkspaceItem['type']],
          minSalience: 0.5,
        }) ?? [];
        if (dreamInsights.length > 0) {
          const insightText = dreamInsights.map(d => d.content).join('\n');
          systemBlocks.push({ type: 'text' as const, text: `\n\n## Subconscious Insights\n${insightText}` });
        }
      }
    }

    // Build tool list (conditionally includes filesystem tools, filtered by intent for Anthropic)
    // Apply tool embodiment: compress descriptions for mastered tools (Merleau-Ponty)
    const rawTools = await this.getTools(options, browserPreActivated || this.browserActivated, sections, desktopPreActivated || this.desktopActivated, undefined, userMessage);
    const cloudToolCount = rawTools.filter(t => t.name.startsWith('cloud_')).length;
    logger.info({ toolCount: rawTools.length, cloudToolCount, sections: [...(sections ?? [])] }, '[orchestrator] Anthropic path tool list');
    const tools = this.brain ? this.brain.applyEmbodiment(rawTools) : rawTools;

    // DELIBERATE: Dialectic check for complex plans (Hegel)
    // Only runs for multi-step tasks where planFirst=true
    if (perception && enriched.planFirst && this.brain) {
      try {
        const plan = await this.brain.deliberate(perception);
        if (plan.counterArgument) {
          const warning = this.brain.formatDialecticWarning(plan.counterArgument);
          // Inject dialectic warning into the dynamic prompt section
          systemBlocks.push({ type: 'text' as const, text: `\n\n${warning}` });
        }
      } catch { /* dialectic is non-fatal enhancement */ }
    }

    // WISDOM: Pre-flight strategic consultation (Luria's prefrontal cortex)
    if (this.brain && enriched.planFirst) {
      try {
        const result = await this.brain.seekWisdom({
          userMessage, toolHistory: '', currentContent: '',
          systemContext: staticPart.slice(0, 500),
        }, 'planning');
        if (result.guidance) {
          systemBlocks.push({ type: 'text' as const, text: `\n\n## Strategic Guidance\n${result.guidance}` });
        }
      } catch { /* non-fatal */ }
    }

    // Intent-aware tool_choice: force tool use for file intent to prevent fabrication
    // Only force on first iteration; subsequent iterations use 'auto'
    let currentToolChoice: { type: 'any' } | { type: 'auto' } = classified.intent === 'file'
      ? { type: 'any' as const }
      : { type: 'auto' as const };

    // Load chat history from session (or use seed messages from cloud proxy)
    const history = seedMessages ? [...seedMessages] : await loadHistory(this.sessionDeps, sessionId);

    // Immune system: scan user input for threats before processing
    if (this.immuneSystem) {
      try {
        const userScan = this.immuneSystem.scan(userMessage, 'user_input');
        if (userScan.detected) {
          this.immuneSystem.respond(userScan);
          if (userScan.recommendation === 'block' || userScan.recommendation === 'quarantine') {
            logger.warn({ pathogen: userScan.pathogenType, confidence: userScan.confidence }, 'immune: blocked user input');
            yield { type: 'text', content: 'This input was flagged by the immune system and cannot be processed.' };
            yield { type: 'done', inputTokens: 0, outputTokens: 0 };
            return;
          }
          if (userScan.recommendation === 'flag') {
            logger.info({ pathogen: userScan.pathogenType, confidence: userScan.confidence }, 'immune: flagged user input');
          }
        }
      } catch { /* immune scanning is non-fatal */ }
    }

    // Add user message
    history.push({ role: 'user', content: userMessage });

    // Smart history truncation: preserve first message (original intent) + summarize middle + keep recent
    const ctxLimit = CLAUDE_CONTEXT_LIMITS['claude-sonnet-4-5'];
    const histBudget = new ContextBudget(ctxLimit, 4096);
    histBudget.setSystemPrompt(systemBlocks.map(b => b.text).join(''));
    histBudget.setToolTokens(estimateToolTokens(convertToolsToOpenAI(tools)));
    const loopMessages = histBudget.summarizeAndTrim(history) as MessageParam[];

    // Track where new messages start (for saving turn context)
    const turnStartIndex = loopMessages.length;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    let fullContent = '';
    const executedToolCalls = new Map<string, ToolResult>();
    const orchToolCallHashes: string[] = [];
    const sessionToolNames: string[] = [];
    const maxIter = MODE_MAX_ITERATIONS[classified.mode] ?? MAX_ITERATIONS;

    // Per-turn consecutive failure breaker. Catches the fast pathology where
    // the model gets confused and calls the same tool 4-5 times in a row,
    // each time getting the same error back, until iteration cap. Nudges at
    // 3 consecutive same-tool failures, hard-aborts at 4. Independent of the
    // process-global CircuitBreaker which tracks cumulative cross-turn flake.
    const consecutiveBreaker = new ConsecutiveToolBreaker();

    // Reset brain session state for this turn
    this.brain?.resetSession();

    // Context budget tracking for Anthropic path
    const anthropicContextLimit = CLAUDE_CONTEXT_LIMITS['claude-sonnet-4-5'];
    let iterationsSinceSummarize = 2; // allow summarization from the start

    for (let iteration = 0; iteration < maxIter; iteration++) {
      // Compact stale tool results before each model call. This walks
      // loopMessages once and replaces tool_result blocks older than
      // KEEP_RECENT_RESULTS with one-line placeholders. The model has
      // already reasoned about those results in prior iterations; the
      // verbatim 5kb directory listings are pure waste from here on.
      compactStaleToolResults(loopMessages as Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: unknown }>);

      // Hard turn-level token budget guard. Project total input tokens
      // against the working context window. If we're past 75%, break
      // out gracefully and yield a continuation message instead of
      // plowing into a 402 / context-limit overflow.
      const staticTokensEst = estimateTokens(systemBlocks.map(b => b.text).join('')) + estimateToolTokens(convertToolsToOpenAI(tools));
      const messageTokensEst = estimateMessagesTokens(loopMessages);
      const verdict = checkTurnTokenBudget({
        contextLimit: anthropicContextLimit,
        reserveForOutput: 4096,
        staticTokens: staticTokensEst,
        messageTokens: messageTokensEst,
        iteration,
        maxIterations: maxIter,
      });
      if (verdict.shouldWarn) {
        logger.warn(`[LocalOrchestrator] Anthropic turn budget at ${Math.round(verdict.utilization * 100)}% (iter ${iteration}/${maxIter}) for session ${sessionId}`);
      }
      if (verdict.shouldBreak) {
        const exitMsg = buildBudgetExitMessage({
          iteration,
          toolsExecuted: executedToolCalls.size,
          reason: verdict.reason,
        });
        yield { type: 'text', content: exitMsg };
        fullContent += exitMsg;
        break;
      }

      // Non-streaming: get full response then yield text blocks. Wrapped in
      // withTimeout so a hung upstream API can't freeze the chat turn forever
      // (bug #6). The signal flows through to the Anthropic SDK so the abort
      // actually frees the in-flight HTTP connection.
      const anthropicCallLabel = `anthropic.messages.create (${this.orchestratorModel || MODEL}, iter ${iteration})`;
      const response = await withTimeout(
        anthropicCallLabel,
        MODEL_CALL_TIMEOUT_MS,
        (signal) => this.anthropic.messages.create(
          {
            model: this.orchestratorModel || MODEL,
            max_tokens: 4096,
            system: systemBlocks,
            messages: loopMessages,
            tools,
            tool_choice: currentToolChoice,
            temperature: 0.5,
          },
          { signal },
        ),
      );

      // Yield text blocks from the response
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          fullContent += block.text;
          yield { type: 'text', content: block.text };
        }
      }

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      const toolUseBlocks = response.content.filter(
        (block): block is ContentBlock & { type: 'tool_use' } => block.type === 'tool_use',
      );

      // Auto-continue if cut off
      if (response.stop_reason === 'max_tokens' && toolUseBlocks.length === 0) {
        const textContent = response.content
          .filter((block): block is TextBlock => block.type === 'text')
          .map((b) => b.text)
          .join('');
        loopMessages.push({ role: 'assistant', content: textContent });
        // After first iteration, switch to auto tool_choice (file intent forces 'any' only on first call)
        currentToolChoice = { type: 'auto' };
        continue;
      }

      // Done if no tool calls — but first check for text-based tool calls
      if (toolUseBlocks.length === 0) {
        const knownToolNames = new Set(tools.map((t: Tool) => t.name));
        const textParsed = extractToolCallsFromText(fullContent, knownToolNames);
        if (textParsed.toolCalls.length > 0) {
          // Synthesize tool_use blocks from text-based calls
          const synthesized: Array<ContentBlock & { type: 'tool_use' }> = textParsed.toolCalls.map((tc, i) => ({
            type: 'tool_use' as const,
            id: `text_call_${i}_${Date.now()}`,
            caller: { type: 'direct' as const },
            name: tc.name,
            input: tc.arguments,
          }));
          // Replace the last yielded text with cleaned version
          if (textParsed.cleanedText !== fullContent) {
            fullContent = textParsed.cleanedText;
          }
          // Push assistant content with synthesized tool_use blocks
          const assistantContent: ContentBlockParam[] = [
            ...(textParsed.cleanedText ? [{ type: 'text' as const, text: textParsed.cleanedText }] : []),
            ...synthesized.map(s => ({ type: 'tool_use' as const, id: s.id, name: s.name, input: s.input })),
          ];
          loopMessages.push({ role: 'assistant', content: assistantContent });

          // Execute synthesized tools
          const toolResults: ToolResultBlockParam[] = [];
          for (const toolUse of synthesized) {
            const req: ToolCallRequest = { id: toolUse.id, name: toolUse.name, input: toolUse.input as Record<string, unknown> };
            const execCtx = this.buildToolExecCtx(executedToolCalls, options, sessionId);
            const gen = executeToolCall(req, execCtx);
            let outcome;
            for (;;) {
              const { value, done } = await gen.next();
              if (done) { outcome = value; break; }
              yield value;
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: outcome.formattedBlocks || (outcome.isError ? outcome.resultContent : outcome.resultContent),
              is_error: outcome.isError,
            });
          }
          loopMessages.push({ role: 'user', content: toolResults });
          currentToolChoice = { type: 'auto' };
          continue;
        }
        break;
      }

      // Append assistant message with full content
      loopMessages.push({
        role: 'assistant',
        content: response.content as ContentBlockParam[],
      });

      // Execute tools in parallel (independent within a single model response)
      // The batch executor runs request_browser first (sequentially) so that
      // browser state is updated before any browser tools in the same batch.
      const toolResults: ToolResultBlockParam[] = [];
      const requests = toolUseBlocks.map(t => ({ id: t.id, name: t.name, input: t.input as Record<string, unknown> }));
      const execCtx = this.buildToolExecCtx(executedToolCalls, options, sessionId);
      const batchGen = executeToolCallsBatch(requests, execCtx);
      let outcomes: import('./tool-executor.js').ToolCallOutcome[];
      for (;;) {
        const { value, done } = await batchGen.next();
        if (done) { outcomes = value; break; }
        yield value;
      }

      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];

        // Circuit breaker: skip disabled tools
        if (this.circuitBreaker.isDisabled(outcome.toolName)) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUseBlocks[i].id,
            content: `Tool "${outcome.toolName}" is temporarily disabled after repeated failures. Try an alternative approach.`,
            is_error: true,
          });
          continue;
        }

        // Record success/failure for both the global cumulative circuit breaker
        // and the per-turn consecutive breaker.
        if (outcome.isError) {
          this.circuitBreaker.recordFailure(outcome.toolName);
        } else {
          this.circuitBreaker.recordSuccess(outcome.toolName);
        }
        const consecutiveDecision = consecutiveBreaker.record(
          outcome.toolName,
          !outcome.isError,
          outcome.isError ? outcome.resultContent : undefined,
        );

        // Handle browser activation: create service and swap tools.
        // Because batch-executor runs request_browser first (before parallel tools),
        // the browserState getter will return the updated state for subsequent tools.
        if (outcome.toolsModified && outcome.toolName === 'request_browser' && !this.browserActivated) {
          await this.activateBrowser(this.browserRequestedProfile);
          const idx = tools.indexOf(REQUEST_BROWSER_TOOL);
          if (idx !== -1) tools.splice(idx, 1, ...BROWSER_TOOL_DEFINITIONS);
        }

        // Handle desktop activation: same pattern as browser
        if (outcome.toolsModified && outcome.toolName === 'request_desktop' && !this.desktopActivated) {
          this.desktopService = new LocalDesktopService({ chromeProfileAliases: this.config.chromeProfileAliases });
          this.desktopActivated = true;
          const idx = tools.indexOf(REQUEST_DESKTOP_TOOL);
          if (idx !== -1) tools.splice(idx, 1, ...DESKTOP_TOOL_DEFINITIONS);
        }

        // Handle filesystem activation: swap gateway for real filesystem + bash tools
        if (outcome.toolsModified && outcome.toolName === 'request_file_access' && !this.filesystemActivated) {
          this.filesystemActivated = true;
          invalidateFileAccessCache();
          invalidateBashAccessCache();
          const idx = tools.indexOf(REQUEST_FILE_ACCESS_TOOL);
          if (idx !== -1) tools.splice(idx, 1, ...FILESYSTEM_TOOL_DEFINITIONS, ...BASH_TOOL_DEFINITIONS);
        }

        // Anthropic format: use formattedBlocks (with images) for browser/desktop results
        // On the 3rd consecutive same-tool failure, append a nudge so the model
        // sees "stop calling this" inline with the next tool result.
        let resultContent: ToolResultBlockParam['content'] = outcome.formattedBlocks || outcome.resultContent;
        if (consecutiveDecision === 'nudge') {
          const nudge = consecutiveBreaker.buildNudgeMessage(outcome.toolName);
          if (typeof resultContent === 'string') {
            resultContent = `${resultContent}${nudge}`;
          } else if (Array.isArray(resultContent)) {
            resultContent = [...resultContent, { type: 'text', text: nudge }];
          }
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseBlocks[i].id,
          content: resultContent,
          is_error: outcome.isError,
        });
      }

      // Hard-abort the turn if any tool just hit the consecutive-failure cap.
      // Push the in-flight tool results first so the model sees the failure
      // chain in history, then break before the next iteration spawns more
      // calls to the same broken tool.
      if (consecutiveBreaker.isAborted()) {
        loopMessages.push({ role: 'user', content: toolResults });
        const abortMsg = consecutiveBreaker.buildAbortMessage();
        yield { type: 'text', content: abortMsg };
        fullContent += abortMsg;
        break;
      }

      // After first tool round, always use auto (file intent forces 'any' only on first call)
      currentToolChoice = { type: 'auto' };

      // Brain: track tool executions (predict → update → embody)
      for (let ti = 0; ti < toolUseBlocks.length; ti++) {
        const block = toolUseBlocks[ti];
        const toolResult = outcomes[ti]?.result;
        if (toolResult && this.brain) {
          this.brain.recordToolExecution(block.name, block.input, toolResult.success);
        }

        // Duplicate tool call detection
        const hash = hashToolCall(block.name, block.input);
        const duplicateCount = orchToolCallHashes.filter(h => h === hash).length;
        if (duplicateCount >= 2) {
          const warning = `\n\nDUPLICATE TOOL CALL: "${block.name}" called ${duplicateCount + 1} times with identical arguments. This approach is not working. Try a completely different strategy or report your current findings to the user.`;
          if (toolResults.length > 0) {
            const lastResult = toolResults[toolResults.length - 1];
            const existingContent = typeof lastResult.content === 'string' ? lastResult.content : '';
            toolResults[toolResults.length - 1] = { ...lastResult, content: `${existingContent}${warning}` };
          }
        }
        orchToolCallHashes.push(hash);
        sessionToolNames.push(block.name);

        // Affect: process tool result -> emotional response (Damasio)
        // Novelty detection via predictive engine: novel tools trigger curiosity, not just satisfaction
        if (toolResult && this.affectEngine) {
          const isNovel = this.brain?.predictiveEngine?.isNovel(block.name) ?? false;
          this.affectEngine.processToolResult(
            block.name, userMessage, toolResult.success, isNovel,
          ).catch(() => { /* non-fatal */ });
        }

        // Endocrine: tool results trigger hormone responses (Spinoza)
        if (toolResult && this.endocrineSystem) {
          if (toolResult.success) {
            this.endocrineSystem.stimulate({ hormone: 'dopamine', delta: 0.05, source: 'tool_execution', reason: `${block.name} succeeded` });
          } else {
            this.endocrineSystem.stimulate({ hormone: 'cortisol', delta: 0.1, source: 'tool_execution', reason: `${block.name} failed` });
          }
        }

        // Habit: record execution for matching habits (Aristotle's hexis)
        if (toolResult && this.habitEngine) {
          const matchingHabits = this.habitEngine.checkCues(block.name, sessionToolNames);
          for (const match of matchingHabits) {
            this.habitEngine.recordExecution(match.habit.id, toolResult.success).catch(() => { /* non-fatal */ });
          }
        }
      }

      // Brain: inject enriched stagnation warning + seek wisdom when stuck
      if (this.brain?.isStagnating() && toolResults.length > 0) {
        const lastResult = toolResults[toolResults.length - 1];
        const existingContent = typeof lastResult.content === 'string' ? lastResult.content : '';
        let warning = this.brain.buildStagnationWarning();

        // Seek wisdom when stuck
        try {
          const toolSummary = [...executedToolCalls.entries()]
            .slice(-10)
            .map(([k, v]) => `${k}: ${v.success ? 'OK' : 'FAILED'}`)
            .join('\n');
          const wisdomResult = await this.brain.seekWisdom({
            userMessage,
            toolHistory: toolSummary,
            currentContent: fullContent.slice(0, 1000),
            systemContext: '',
          }, 'stuck');
          if (wisdomResult.guidance) {
            warning += `\n\n## Wisdom (course correction)\n${wisdomResult.guidance}`;
          }
        } catch { /* non-fatal */ }

        toolResults[toolResults.length - 1] = {
          ...lastResult,
          content: `${existingContent}\n\n${warning}`,
        };
      }

      // Brain: temporal-aware reflection (Heidegger's temporality)
      const recentToolNames = outcomes.map(o => o.toolName);
      const reflectionText = this.brain
        ? this.brain.buildReflection(userMessage, recentToolNames, iteration, maxIter)
        : buildReflectionPrompt(userMessage, executedToolCalls, iteration, maxIter);
      const goalReminderBlock: TextBlockParam = { type: 'text', text: reflectionText };
      loopMessages.push({ role: 'user', content: [...toolResults, goalReminderBlock] });

      // Homeostasis: dispatch corrective actions mid-loop
      if (this.homeostasisController) {
        try {
          const hoState = this.homeostasisController.check();
          for (const action of hoState.correctiveActions) {
            if (action.type === 'compress_memory' && action.urgency > 0.5) {
              // Will be applied if/when context trimming runs below
              logger.debug({ urgency: action.urgency }, 'homeostasis: compress_memory action active');
            }
          }
        } catch { /* non-fatal */ }
      }

      // Mid-loop context budget check for Anthropic path
      iterationsSinceSummarize++;
      const utilizationPct = totalInputTokens / anthropicContextLimit;
      if (utilizationPct >= 0.7) {
        logger.warn(`[LocalOrchestrator] Anthropic context at ${Math.round(utilizationPct * 100)}% for session ${sessionId}`);
      }
      if (
        utilizationPct >= 0.6 &&
        iterationsSinceSummarize >= 2 &&
        loopMessages.length > 6
      ) {
        // Summarize older messages using ContextBudget.summarizeAndTrim
        const budgetForTrim = new ContextBudget(anthropicContextLimit, 4096);
        budgetForTrim.setSystemPrompt('x'.repeat(estimateTokens(staticPart + dynamicPart) * 4));
        const summarized = budgetForTrim.summarizeAndTrim(loopMessages as Array<{ role: string; content: string | unknown[] }>);
        if (summarized.length < loopMessages.length) {
          logger.info(`[LocalOrchestrator] Mid-loop summarization: ${loopMessages.length} → ${summarized.length} messages`);
          loopMessages.length = 0;
          loopMessages.push(...(summarized as MessageParam[]));
          iterationsSinceSummarize = 0;
        }
      }
    }

    // WISDOM: Completion validation — seek wisdom before finalizing complex tasks
    if (this.brain && enriched.planFirst && fullContent.length > 200) {
      try {
        const toolSummary = [...executedToolCalls.entries()]
          .map(([k, v]) => `${k}: ${v.success ? 'OK' : 'FAILED'}`)
          .join('\n');
        const wisdomResult = await this.brain.seekWisdom({
          userMessage,
          toolHistory: toolSummary,
          currentContent: fullContent.slice(0, 2000),
          systemContext: '',
        }, 'validation');
        if (wisdomResult.guidance && !wisdomResult.guidance.toUpperCase().startsWith('PROCEED')) {
          yield { type: 'text', content: `\n\n*Strategic review: ${wisdomResult.guidance}*` };
        }
      } catch { /* non-fatal */ }
    }

    // Save to session (full turn with tool context)
    const turnMessages = buildAnthropicTurnMessages(userMessage, loopMessages, turnStartIndex, fullContent);
    await saveToSession(this.sessionDeps, sessionId, turnMessages, userMessage.slice(0, 100));

    // Persist to append-only conversation history + schedule idle extraction (fire-and-forget)
    if (fullContent) {
      persistExchange(this.sessionDeps, sessionId, userMessage, fullContent, {
        title: userMessage.slice(0, 100),
        extractionDeps: { anthropic: this.anthropic, modelRouter: this.modelRouter },
      }).catch((err) => {
        logger.warn(`[LocalOrchestrator] Conversation persistence failed: ${err}`);
      });
    }

    // Extract orchestrator memory every 3rd exchange (fire-and-forget)
    this.exchangeCount++;
    if (this.exchangeCount % 3 === 0 && fullContent) {
      extractOrchestratorMemory(this.memoryDeps, sessionId, userMessage, fullContent).catch((err) => {
        logger.error(`[LocalOrchestrator] Memory extraction failed: ${err}`);
      });
    }

    // Ambient wiki curation: every turn, reflect on whether the
    // exchange contained durable info worth saving to the wiki. Skipped
    // automatically when the COS already called wiki_write_page in-turn,
    // since the system-prompt nudge handled it.
    if (fullContent) {
      const curatedInTurn = executedToolCalls.has('wiki_write_page');
      reflectOnWikiOpportunities(
        { modelRouter: this.modelRouter, toolCtx: this.buildToolCtx(sessionId) },
        userMessage,
        fullContent,
        { skipIfCuratedInTurn: curatedInTurn },
      ).catch((err) => {
        logger.warn(`[LocalOrchestrator] Wiki reflection failed: ${err}`);
      });
    }

    // Flush brain experience stream for cross-session persistence
    await this.brain?.flush();

    // NOTE: trackSkillUsage() removed — code skills have their own
    // success_count/fail_count metrics path in runtime-skill-metrics.ts,
    // driven by tool-executor on every dispatch. The deleted method
    // was specific to procedure skills' EMA rolling-average
    // success_rate, which is no longer a concept in the runtime.

    yield {
      type: 'done',
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      traceId,
    };
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /** Run a sub-orchestrator for delegate_subtask tool calls. */
  private async runDelegateSubtask(prompt: string, focus: string, options?: ChannelChatOptions, depth = 0): Promise<SubOrchestratorResult> {
    // Per-focus iteration budgets. Janitorial work (wiki cleanup) needs
    // headroom to walk a backlog of lint findings — one read+write pair
    // per finding, plus the bracketing lint calls. The default 5 caps
    // out after fixing 1-2 issues.
    const focusIterations: Record<string, number> = {
      wiki: 18,
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
    });
  }

  /** Check if the orchestrator has file access paths configured. */
  private async hasOrchestratorFileAccess(): Promise<boolean> {
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
  private async getTools(
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

  // ==========================================================================
  // OLLAMA TOOL-CALLING LOOP
  // ==========================================================================

  /**
   * Select the best model for a given tool-loop iteration.
   * Iteration 0: Grok 4.20 (2M context, strong reasoning — the orchestrator brain)
   * Follow-ups: Grok 4.1 Fast (cheap tool routing and summaries)
   * Escalates back to 4.20 for errors, heavy tool results, or complex processing.
   */
  private selectModelForIteration(
    iteration: number,
    messages: OllamaMessage[],
    previousToolCallCount: number,
    hasErrors: boolean,
  ): string {
    const CHEAP = 'x-ai/grok-4.1-fast';
    const STRONG = 'x-ai/grok-4.20';
    const configured = this.orchestratorModel;

    // If user explicitly configured a non-grok model, respect it
    if (configured && !configured.startsWith('x-ai/grok-')) {
      return configured;
    }

    // Iteration 0: always use the strong model (2M context brain)
    // The orchestrator needs deep context for initial reasoning, tool planning,
    // and sub-orchestrator coordination
    if (iteration === 0) return STRONG;

    // Escalate on errors or retries
    if (hasErrors) return STRONG;

    // Heavy tool iteration (lots of tool results to process): escalate
    if (previousToolCallCount >= 4) return STRONG;

    // Long tool results in recent messages: escalate
    const recentMessages = messages.slice(-3);
    const hasLongToolResults = recentMessages.some(
      m => m.role === 'tool' && typeof m.content === 'string' && m.content.length > 5000
    );
    if (hasLongToolResults) return STRONG;

    // Follow-up iterations: cheap model for tool routing and summaries
    return CHEAP;
  }

  /**
   * Dedicated OpenRouter tool loop — full Anthropic-path intelligence with
   * native OpenAI chat/completions format + streaming. OpenRouter cloud models
   * have 128K-1M context, so they get the same capabilities as direct Claude:
   * brain perception, philosophical layers, tool embodiment, deliberation,
   * affect/endocrine/habit tracking, mid-loop summarization.
   *
   * Only format differences from the Anthropic path:
   * - System prompt as string (no TextBlockParam[], no cache_control)
   * - Tools in OpenAI format (not Anthropic input_schema)
   * - Streaming via createMessageWithToolsStreaming
   * - History in OpenAI message format
   */
  private async *runOpenRouterToolLoop(
    userMessage: string,
    sessionId: string,
    provider: OpenRouterProvider,
    options?: ChannelChatOptions,
    seedMessages?: MessageParam[],
  ): AsyncGenerator<OrchestratorEvent> {
    const traceId = crypto.randomUUID();

    // Classify intent, inheriting previous intent for confirmations
    const previousIntent = this.lastIntentBySession.get(sessionId);
    const classified = classifyIntent(userMessage, previousIntent);

    // PERCEIVE: Full cognitive cycle (Husserl's intentionality)
    let perception: Perception | null = null;
    if (this.brain) {
      const isVoice = options?.platform === 'voice';
      const stimulus: Stimulus = {
        type: isVoice ? 'auditory_input' : 'user_message',
        content: userMessage,
        source: isVoice ? 'voice' : 'orchestrator',
        timestamp: Date.now(),
        voiceContext: options?.voiceContext ? {
          sttConfidence: options.voiceContext.sttConfidence,
          sttProvider: options.voiceContext.sttProvider,
          language: options.voiceContext.language,
          durationMs: options.voiceContext.audioDurationMs,
        } : undefined,
      };
      const selfModelDeps: SelfModelDeps = {
        activeModel: this.getActiveModel(),
        modelCapabilities: ['tool_calling'],
        tokenBudgetRemaining: 4096,
        limitations: [],
        currentLoad: 0,
        bodyProprioception: this.brain?.getProprioception(),
      };
      perception = this.brain.perceive(stimulus, classified, selfModelDeps);
    }
    const enriched = perception?.intent ?? enrichIntent(classified, userMessage);
    const { sections, statusLabel } = enriched;
    yield { type: 'status', message: statusLabel };
    this.lastIntentBySession.set(sessionId, enriched);

    // Auto-activate browser when intent is 'browser'
    const browserPreActivated = sections.has('browser') && classified.intent === 'browser';
    if (this.browserService && !this.browserService.isActive()) {
      logger.debug('[browser] Browser process no longer active — nullifying (openrouter)');
      this.browserService = null;
      this.browserActivated = false;
      this.syncOrganToBody();
    }
    if (browserPreActivated && !this.browserActivated) {
      logger.debug(`[browser] Pre-activating browser (openrouter) — target: ${this.browserTarget}`);
      await this.activateBrowser();
    }

    // Auto-activate desktop when intent is 'desktop'
    const desktopPreActivated = sections.has('desktop') && classified.intent === 'desktop';
    if (desktopPreActivated && !this.desktopActivated) {
      logger.debug('[desktop] Pre-activating desktop control (openrouter)');
      this.desktopService = new LocalDesktopService({ chromeProfileAliases: this.config.chromeProfileAliases });
      this.desktopActivated = true;
      this.syncOrganToBody();
    }

    // Load active persona for this conversation. If a team member's guide
    // agent (or any other agent) has been installed as the persona, we use
    // THAT agent's system_prompt + model_policy + temperature instead of the
    // generic orchestrator build. This is how assigned guide agents
    // actually drive a thread. Absent persona = orchestrator as usual.
    const activePersona = await loadConversationPersona(this.db, this.workspaceId, sessionId);
    if (activePersona) {
      logger.info(
        { sessionId, agentId: activePersona.agentId, name: activePersona.name, model: activePersona.modelDefault },
        '[orchestrator] active persona is driving this turn',
      );
    }

    // Build system prompt as plain string (no TextBlockParam arrays, no cache_control)
    const displayLayout = this.desktopService ? buildDisplayLayout(this.desktopService.getScreenInfo().displays) : undefined;
    const hasMcpTools = this.mcp.hasTools();
    const mcpServerNames = hasMcpTools ? this.mcp.getServerNames() : undefined;
    const { staticPart, dynamicPart } = await buildTargetedPrompt(
      this.promptDeps, userMessage, sections,
      browserPreActivated || this.browserActivated, options?.platform,
      desktopPreActivated || this.desktopActivated, undefined, displayLayout, hasMcpTools,
      mcpServerNames,
    );
    let systemPrompt = activePersona
      ? `${activePersona.systemPrompt}\n\n## Runtime footer\nYou are speaking inside an OHWOW chat thread. You still have the full orchestrator tool catalog — use it freely (create_team_member, update_person_model, get_knowledge_document, run_bash, etc.). Stay in character as ${activePersona.name}${activePersona.role ? ` (${activePersona.role})` : ''} for every reply. To hand control back to the generic orchestrator, call deactivate_persona.`
      : staticPart + '\n\n' + dynamicPart;

    // Active goal checkpoints (cross-session continuity)
    const goalDeps: GoalCheckpointDeps = { db: this.db, workspaceId: this.workspaceId, modelRouter: this.modelRouter };
    const activeGoals = await loadActiveGoals(goalDeps);
    const goalsSection = formatGoalsForPrompt(activeGoals);
    if (goalsSection) systemPrompt += `\n\n${goalsSection}`;

    // Full philosophical layers — OpenRouter cloud models have 128K+ context

    // Persona (Aristotle's Psyche)
    const personaContext = this.soul.buildPromptContext();
    if (personaContext) {
      systemPrompt += `\n\n## Human Awareness\n${personaContext}`;
    }
    this.soul.observer.observe({ type: 'message_sent', timestamp: Date.now(), metadata: { wordCount: userMessage.split(/\s+/).length, sessionId } });

    // True Soul (Plato's Tripartite + Jung's Shadow)
    try {
      const { TrueSoul } = await import('../soul/soul.js');
      const trueSoul = new TrueSoul();
      const soulContext = trueSoul.buildPromptContext();
      if (soulContext) {
        systemPrompt += `\n\n## Soul Awareness\n${soulContext}`;
      }
      if (soulContext && this.exchangeCount > 0 && this.exchangeCount % 50 === 0 && this.db) {
        this.db.from('soul_snapshots').insert({
          workspace_id: this.workspaceId, agent_id: this.workspaceId,
          soul: JSON.stringify({ promptContext: soulContext }), confidence: 0.5,
          emerging_identity: soulContext.slice(0, 200),
        }).then(() => {}, () => {});
      }
    } catch { /* non-fatal */ }

    // Body Awareness (Merleau-Ponty)
    const proprioception = this.brain?.getProprioception();
    const bodyLines: string[] = [];
    if (proprioception && proprioception.organs.length > 0) {
      const activeOrgans = proprioception.organs.filter(o => o.health !== 'dormant');
      const degraded = activeOrgans.filter(o => o.health === 'degraded' || o.health === 'failed');
      const affordances = proprioception.affordances.filter(a => a.readiness > 0.5);
      if (activeOrgans.length > 0) bodyLines.push(`Active capabilities: ${activeOrgans.map(o => `${o.name} (${o.health})`).join(', ')}`);
      if (degraded.length > 0) bodyLines.push(`Degraded: ${degraded.map(o => `${o.name} is ${o.health}`).join(', ')}`);
      if (affordances.length > 0) bodyLines.push(`Available actions: ${affordances.map(a => a.action).join(', ')}`);
    }
    try {
      if (!this.bodyStateService) {
        this.bodyStateService = new BodyStateService(this.db, this.workspaceId, this.digitalBody ?? undefined);
      }
      const bsSummary = await this.bodyStateService.getProprioceptiveSummary();
      if (bsSummary) bodyLines.push(bsSummary);
    } catch { /* non-fatal */ }
    if (bodyLines.length > 0) {
      systemPrompt += `\n\n## Body Awareness\n${bodyLines.join('\n')}`;
    }

    // System Warnings
    const healthWarnings = this.brain?.workspace.getConscious(3, { types: ['failure', 'warning'], minSalience: 0.5 }) ?? [];
    if (healthWarnings.length > 0) {
      systemPrompt += `\n\n## System Warnings\n${healthWarnings.map(w => w.content).join('\n')}`;
    }

    // Emotional Context (Damasio's somatic markers)
    const orAffectCtx = this.affectEngine?.buildPromptContext();
    if (orAffectCtx) systemPrompt += `\n\n## Emotional Context\n${orAffectCtx}`;

    // Internal State (Spinoza's endocrine)
    const orEndoCtx = this.endocrineSystem?.buildPromptContext();
    if (orEndoCtx) systemPrompt += `\n\n## Internal State\n${orEndoCtx}`;

    // Self-Regulation (Cannon's homeostasis)
    const orHomeoCtx = this.homeostasisController?.buildPromptContext();
    if (orHomeoCtx) systemPrompt += `\n\n## Self-Regulation\n${orHomeoCtx}`;

    // Security Alert (immune system)
    const orImmuneCtx = this.immuneSystem?.buildPromptContext();
    if (orImmuneCtx) systemPrompt += `\n\n## Security Alert\n${orImmuneCtx}`;

    // Your Story (Ricoeur's narrative)
    const orNarrCtx = this.narrativeEngine?.buildPromptContext();
    if (orNarrCtx) systemPrompt += `\n\n## Your Story\n${orNarrCtx}`;

    // Ethical Awareness (Aristotle + Kant)
    const orEthicsCtx = this.ethicsEngine?.buildPromptContext(null);
    if (orEthicsCtx) systemPrompt += `\n\n## Ethical Awareness\n${orEthicsCtx}`;

    // Available Shortcuts (habit engine)
    if (this.habitEngine) {
      const habitMatches = this.habitEngine.checkCues(userMessage, []);
      if (habitMatches.length > 0) {
        systemPrompt += `\n\n## Available Shortcuts\n${habitMatches.slice(0, 3).map(m => m.suggestedShortcut).join('\n')}`;
      }
    }

    // Subconscious Insights (dream engine)
    if (this.sleepCycle && !this.sleepCycle.isAsleep()) {
      const dreamInsights = this.brain?.workspace.getConscious(2, { types: ['dream' as WorkspaceItem['type']], minSalience: 0.5 }) ?? [];
      if (dreamInsights.length > 0) {
        systemPrompt += `\n\n## Subconscious Insights\n${dreamInsights.map(d => d.content).join('\n')}`;
      }
    }

    // Tools: full set with embodiment (same as Anthropic path)
    const rawTools = await this.getTools(options, browserPreActivated || this.browserActivated, sections, desktopPreActivated || this.desktopActivated, undefined, userMessage);
    const embeddedTools = this.brain ? this.brain.applyEmbodiment(rawTools) : rawTools;
    let openaiTools = convertToolsToOpenAI(embeddedTools);
    logger.info({ toolCount: openaiTools.length, sections: [...(sections ?? [])] }, '[orchestrator] OpenRouter path tool list');

    // DELIBERATE: Dialectic check for complex plans (Hegel)
    if (perception && enriched.planFirst && this.brain) {
      try {
        const plan = await this.brain.deliberate(perception);
        if (plan.counterArgument) {
          const warning = this.brain.formatDialecticWarning(plan.counterArgument);
          systemPrompt += `\n\n${warning}`;
        }
      } catch { /* non-fatal */ }
    }

    // WISDOM: Pre-flight strategic consultation (Luria's prefrontal cortex)
    if (this.brain && enriched.planFirst) {
      try {
        const result = await this.brain.seekWisdom({
          userMessage, toolHistory: '', currentContent: '',
          systemContext: staticPart.slice(0, 500),
        }, 'planning');
        if (result.guidance) {
          systemPrompt += `\n\n## Strategic Guidance\n${result.guidance}`;
        }
      } catch { /* non-fatal */ }
    }

    // Immune system: scan user input
    if (this.immuneSystem) {
      try {
        const userScan = this.immuneSystem.scan(userMessage, 'user_input');
        if (userScan.detected) {
          this.immuneSystem.respond(userScan);
          if (userScan.recommendation === 'block' || userScan.recommendation === 'quarantine') {
            logger.warn({ pathogen: userScan.pathogenType, confidence: userScan.confidence }, 'immune: blocked user input (openrouter)');
            yield { type: 'text', content: 'This input was flagged by the immune system and cannot be processed.' };
            yield { type: 'done', inputTokens: 0, outputTokens: 0 };
            return;
          }
        }
      } catch { /* non-fatal */ }
    }

    // Load history and apply context budget
    const history = seedMessages ? [...seedMessages] : await loadHistory(this.sessionDeps, sessionId);
    history.push({ role: 'user', content: userMessage });

    const toolTokenCount = estimateToolTokens(openaiTools);
    // Grok models have 2M context; other OpenRouter models typically 128K+
    const modelId = this.orchestratorModel || 'x-ai/grok-4.20';
    const contextLimit = modelId.includes('grok') ? 2_000_000 : 128_000;
    const budget = new ContextBudget(contextLimit, 4096);
    budget.setSystemPrompt(systemPrompt);
    budget.setToolTokens(toolTokenCount);
    const truncatedHistory = budget.summarizeAndTrim(history);

    // Convert history to OpenAI message format
    const loopMessages: OllamaMessage[] = [];
    for (const m of truncatedHistory) {
      if (typeof m.content === 'string') {
        loopMessages.push({ role: m.role as 'user' | 'assistant', content: m.content });
      } else if (Array.isArray(m.content)) {
        const blocks = m.content as ContentBlockParam[];
        const hasToolUse = blocks.some(b => b.type === 'tool_use');
        const hasToolResult = blocks.some(b => b.type === 'tool_result');
        if (hasToolUse && m.role === 'assistant') {
          const textParts = blocks.filter(b => b.type === 'text').map(b => (b as TextBlockParam).text);
          const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => {
            const tu = b as ContentBlockParam & { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
            return { id: tu.id, type: 'function' as const, function: { name: tu.name, arguments: JSON.stringify(tu.input) } };
          });
          loopMessages.push({ role: 'assistant', content: textParts.join(''), tool_calls: toolCalls });
        } else if (hasToolResult && m.role === 'user') {
          for (const b of blocks) {
            if (b.type === 'tool_result') {
              const tr = b as ToolResultBlockParam;
              loopMessages.push({
                role: 'tool',
                content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
                tool_call_id: tr.tool_use_id,
              });
            }
          }
        } else {
          loopMessages.push({ role: m.role as 'user' | 'assistant', content: JSON.stringify(m.content) });
        }
      }
    }

    const turnStartIndex = loopMessages.length;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let fullContent = '';
    const executedToolCalls = new Map<string, ToolResult>();
    const toolCallHashes: string[] = [];
    const sessionToolNames: string[] = [];
    const maxIter = MODE_MAX_ITERATIONS[classified.mode] ?? MAX_ITERATIONS;
    let iterationsSinceSummarize = 2;
    let prevIterToolCount = 0;
    let iterHadErrors = false;
    const consecutiveBreaker = new ConsecutiveToolBreaker();
    let openrouterAborted = false;

    this.brain?.resetSession();

    for (let iteration = 0; iteration < maxIter; iteration++) {
      // Evict old screenshots: keep only the most recent image to avoid
      // blowing the context window on multi-step desktop workflows.
      // Each base64 screenshot is ~40-50K tokens.
      if (iteration > 0) {
        let lastImageIdx = -1;
        for (let i = loopMessages.length - 1; i >= 0; i--) {
          const c = loopMessages[i].content;
          if (Array.isArray(c) && c.some(p => p.type === 'image_url')) {
            if (lastImageIdx === -1) {
              lastImageIdx = i;
            } else {
              const filtered = c.filter(p => p.type !== 'image_url');
              if (filtered.length === 1 && filtered[0].type === 'text') {
                loopMessages[i].content = filtered[0].text || '';
              } else {
                loopMessages[i].content = filtered;
              }
            }
          }
        }
      }

      // Compact stale tool results before each model call. OpenAI-shape
      // messages put tool results in top-level role:'tool' messages.
      compactStaleOpenAIToolResults(loopMessages as Array<{ role: string; content: unknown }>);

      // Hard turn-level token budget guard. OpenRouter contexts vary
      // by model — use the same ceiling we passed to the budget, so
      // the guard fires before the budget shim does.
      {
        const staticTokensEst = estimateTokens(systemPrompt) + toolTokenCount;
        const messageTokensEst = estimateMessagesTokens(loopMessages);
        const verdict = checkTurnTokenBudget({
          contextLimit,
          reserveForOutput: 4096,
          staticTokens: staticTokensEst,
          messageTokens: messageTokensEst,
          iteration,
          maxIterations: maxIter,
        });
        if (verdict.shouldWarn) {
          logger.warn(`[orchestrator] OpenRouter turn budget at ${Math.round(verdict.utilization * 100)}% (iter ${iteration}/${maxIter}) for session ${sessionId}`);
        }
        if (verdict.shouldBreak) {
          const exitMsg = buildBudgetExitMessage({
            iteration,
            toolsExecuted: executedToolCalls.size,
            reason: verdict.reason,
          });
          yield { type: 'text', content: exitMsg };
          fullContent += exitMsg;
          break;
        }
      }

      // Per-iteration model selection: cheapest model that can handle this step
      // Persona override: when an agent is driving the thread, respect its
      // model_policy.default. The orchestrator's iteration-tier routing
      // assumes a single-model orchestrator voice — a persona's own policy
      // is the source of truth while it's in control.
      const iterModel = activePersona?.modelDefault
        ?? this.selectModelForIteration(iteration, loopMessages, prevIterToolCount, iterHadErrors);
      if (iteration === 0 || iterModel !== (this.orchestratorModel || 'x-ai/grok-4.1-fast')) {
        logger.debug({ iteration, model: iterModel, persona: activePersona?.name }, '[orchestrator] iteration model selected');
      }
      iterHadErrors = false;

      let response: ModelResponseWithTools;
      // Per-iteration timeout via AbortController. The signal flows through
      // to the underlying fetch so a hung upstream OpenRouter API gets
      // cancelled cleanly instead of freezing the for-await iterator forever
      // (bug #6 fix). On TimeoutError we yield an explanatory message and
      // break the loop so the async dispatch can flip status='error'.
      const orStreamTimer = createTimeoutController(
        `OpenRouter stream (${iterModel}, iter ${iteration})`,
        MODEL_CALL_TIMEOUT_MS,
      );
      try {
        const thinkFilter = new ThinkTagFilter();
        const stream = provider.createMessageWithToolsStreaming({
          model: iterModel,
          system: systemPrompt,
          messages: loopMessages.map(m => ({
            role: m.role,
            content: m.content,
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          })),
          maxTokens: 4096,
          temperature: activePersona?.temperature ?? 0.5,
          tools: openaiTools,
          signal: orStreamTimer.signal,
        });
        let streamResult: IteratorResult<{ type: 'token'; content: string }, ModelResponseWithTools>;
        while (true) {
          streamResult = await stream.next();
          if (streamResult.done) {
            response = streamResult.value;
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
      } catch (err) {
        if (err instanceof TimeoutError) {
          logger.warn({ err: err.message, model: iterModel, iteration }, '[orchestrator] OpenRouter model call timed out');
          yield { type: 'text', content: `Model call timed out after ${Math.round(err.elapsedMs / 1000)}s (${iterModel}). Try again or pick a different model.` };
          throw err; // propagate so the async dispatch flips status='error'
        }
        logger.error({ err }, '[orchestrator] OpenRouter tool loop error');
        yield { type: 'text', content: 'Something went wrong with the AI provider. Try again.' };
        break;
      } finally {
        orStreamTimer.cancel();
      }

      totalInputTokens += response.inputTokens;
      totalOutputTokens += response.outputTokens;

      const hasToolCalls = response.toolCalls && response.toolCalls.length > 0;

      if (response.content && !hasToolCalls) {
        const cleaned = stripThinkTags(response.content);
        if (cleaned) fullContent += cleaned;
      }

      // No text-based tool extraction for OpenRouter — structured tool_calls only
      if (!hasToolCalls) break;

      // Append assistant message with tool calls
      loopMessages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: tc.function,
        })),
      });

      // Parse and execute tool calls
      const toolResultsSummary: { name: string; content: string }[] = [];
      const screenshotImages: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
      const validRequests: { req: ToolCallRequest; toolCall: typeof response.toolCalls[0] }[] = [];
      const toolLoopAborted = false;

      for (let toolCall of response.toolCalls) {
        const repairResult = repairToolCall(toolCall, openaiTools);
        if (repairResult.repairs.length > 0) {
          logger.info(`[orchestrator] OpenRouter tool call repaired: ${repairResult.repairs.join(', ')}`);
          toolCall = repairResult.toolCall;
        }
        if (repairResult.error) {
          logger.warn(`[orchestrator] OpenRouter tool call repair failed: ${repairResult.error}`);
          loopMessages.push({ role: 'tool', content: repairResult.error, tool_call_id: toolCall.id });
          toolResultsSummary.push({ name: toolCall.function.name || 'unknown_tool', content: repairResult.error });
          continue;
        }

        const toolName = toolCall.function.name;
        if (!toolName) {
          const errorMsg = 'Tool call missing function name. Provide a valid tool name.';
          loopMessages.push({ role: 'tool', content: errorMsg, tool_call_id: toolCall.id });
          toolResultsSummary.push({ name: 'unknown_tool', content: errorMsg });
          continue;
        }

        const parsed = parseToolArguments(toolCall.function.arguments, toolName);
        if (parsed.error) {
          loopMessages.push({ role: 'tool', content: parsed.error, tool_call_id: toolCall.id });
          toolResultsSummary.push({ name: toolName, content: parsed.error });
          continue;
        }

        let toolInput = parsed.args;
        if (options?.transformToolInput) {
          toolInput = options.transformToolInput(toolName, toolInput);
        }

        validRequests.push({ req: { id: toolCall.id, name: toolName, input: toolInput }, toolCall });
      }

      if (toolLoopAborted) break;

      // Execute tool calls
      if (validRequests.length > 0) {
        const execCtx = this.buildToolExecCtx(executedToolCalls, options, sessionId);
        const batchGen = executeToolCallsBatch(validRequests.map(v => v.req), execCtx);
        let outcomes: import('./tool-executor.js').ToolCallOutcome[];
        for (;;) {
          const { value, done } = await batchGen.next();
          if (done) { outcomes = value; break; }
          yield value;
        }

        for (let i = 0; i < outcomes.length; i++) {
          const outcome = outcomes[i];
          const { req, toolCall } = validRequests[i];

          // Circuit breaker: skip disabled tools
          if (this.circuitBreaker.isDisabled(outcome.toolName)) {
            loopMessages.push({ role: 'tool', content: `Tool "${outcome.toolName}" is temporarily disabled after repeated failures. Try an alternative approach.`, tool_call_id: toolCall.id });
            toolResultsSummary.push({ name: req.name, content: 'Tool disabled by circuit breaker' });
            continue;
          }
          if (outcome.isError) {
            this.circuitBreaker.recordFailure(outcome.toolName);
          } else {
            this.circuitBreaker.recordSuccess(outcome.toolName);
          }
          const consecutiveDecision = consecutiveBreaker.record(
            outcome.toolName,
            !outcome.isError,
            outcome.isError ? outcome.resultContent : undefined,
          );

          // Handle browser activation
          if (outcome.toolsModified && outcome.toolName === 'request_browser' && !this.browserActivated) {
            await this.activateBrowser();
            const browserOpenAI = convertToolsToOpenAI(BROWSER_TOOL_DEFINITIONS);
            openaiTools = openaiTools.filter((t) => t.function.name !== 'request_browser');
            openaiTools = [...openaiTools, ...browserOpenAI];
          }

          // Handle desktop activation
          if (outcome.toolsModified && outcome.toolName === 'request_desktop' && !this.desktopActivated) {
            this.desktopService = new LocalDesktopService({ chromeProfileAliases: this.config.chromeProfileAliases });
            this.desktopActivated = true;
            const desktopOpenAI = convertToolsToOpenAI(DESKTOP_TOOL_DEFINITIONS);
            openaiTools = openaiTools.filter((t) => t.function.name !== 'request_desktop');
            openaiTools = [...openaiTools, ...desktopOpenAI];
          }

          // Handle filesystem activation
          if (outcome.toolsModified && outcome.toolName === 'request_file_access' && !this.filesystemActivated) {
            this.filesystemActivated = true;
            invalidateFileAccessCache();
            invalidateBashAccessCache();
            const fsOpenAI = convertToolsToOpenAI([...FILESYSTEM_TOOL_DEFINITIONS, ...BASH_TOOL_DEFINITIONS]);
            openaiTools = openaiTools.filter((t) => t.function.name !== 'request_file_access');
            openaiTools = [...openaiTools, ...fsOpenAI];
          }

          // Brain: record tool execution
          this.brain?.recordToolExecution(req.name, req.input, outcome.result.success);

          // Affect: emotional response (Damasio)
          if (outcome.result && this.affectEngine) {
            const isNovel = this.brain?.predictiveEngine?.isNovel(req.name) ?? false;
            this.affectEngine.processToolResult(req.name, userMessage, outcome.result.success, isNovel).catch(() => {});
          }

          // Endocrine: hormone responses (Spinoza)
          if (outcome.result && this.endocrineSystem) {
            if (outcome.result.success) {
              this.endocrineSystem.stimulate({ hormone: 'dopamine', delta: 0.05, source: 'tool_execution', reason: `${req.name} succeeded` });
            } else {
              this.endocrineSystem.stimulate({ hormone: 'cortisol', delta: 0.1, source: 'tool_execution', reason: `${req.name} failed` });
            }
          }

          // Habit: record execution (Aristotle's hexis)
          if (outcome.result && this.habitEngine) {
            const matchingHabits = this.habitEngine.checkCues(req.name, sessionToolNames);
            for (const match of matchingHabits) {
              this.habitEngine.recordExecution(match.habit.id, outcome.result.success).catch(() => {});
            }
          }

          sessionToolNames.push(req.name);
          // On 3rd consecutive same-tool failure, append a stop-and-rethink nudge
          // to the tool message the model sees next iteration.
          let toolMessageContent = outcome.resultContent;
          if (consecutiveDecision === 'nudge') {
            toolMessageContent = `${toolMessageContent}${consecutiveBreaker.buildNudgeMessage(outcome.toolName)}`;
          }
          loopMessages.push({ role: 'tool', content: toolMessageContent, tool_call_id: toolCall.id });
          toolResultsSummary.push({ name: req.name, content: toolMessageContent });

          // Collect base64 images from formattedBlocks for vision-capable models (OpenRouter path)
          if (outcome.formattedBlocks) {
            for (const block of outcome.formattedBlocks) {
              if (block.type === 'image' && 'source' in block) {
                const src = (block as { type: 'image'; source: { type: string; media_type: string; data: string } }).source;
                if (src.type === 'base64' && src.data) {
                  screenshotImages.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } });
                }
              }
            }
          }
        }

        // Hard-abort if any tool just hit the consecutive-failure cap.
        if (consecutiveBreaker.isAborted()) {
          const abortMsg = consecutiveBreaker.buildAbortMessage();
          yield { type: 'text', content: abortMsg };
          fullContent += abortMsg;
          openrouterAborted = true;
          break;
        }
      }

      if (openrouterAborted) break;

      // Duplicate tool call detection
      for (const { req } of validRequests) {
        const hash = hashToolCall(req.name, req.input);
        const duplicateCount = toolCallHashes.filter(h => h === hash).length;
        if (duplicateCount >= 2) {
          const warning = `\n\nDUPLICATE TOOL CALL: "${req.name}" called ${duplicateCount + 1} times with identical arguments. This approach is not working. Try a completely different strategy or report your current findings to the user.`;
          if (loopMessages.length > 0 && loopMessages[loopMessages.length - 1].role === 'tool') {
            loopMessages[loopMessages.length - 1].content += warning;
          }
        }
        toolCallHashes.push(hash);
      }

      // Brain: stagnation warning + WISDOM consultation when stuck
      let stagnationWarning = '';
      if (this.brain?.isStagnating()) {
        stagnationWarning = `\n\n${this.brain.buildStagnationWarning()}`;

        // Seek wisdom when stuck — consult stronger model for course correction
        try {
          const toolSummary = [...executedToolCalls.entries()]
            .slice(-10)
            .map(([k, v]) => `${k}: ${v.success ? 'OK' : 'FAILED'}`)
            .join('\n');
          const wisdomResult = await this.brain.seekWisdom({
            userMessage,
            toolHistory: toolSummary,
            currentContent: fullContent.slice(0, 1000),
            systemContext: '',
          }, 'stuck');
          if (wisdomResult.guidance) {
            stagnationWarning += `\n\n## Wisdom (course correction)\n${wisdomResult.guidance}`;
          }
        } catch { /* non-fatal */ }
      }

      // Brain: temporal-aware reflection (Heidegger's temporality)
      const recentToolNames = validRequests.map(v => v.req.name);
      const reflectionText = this.brain
        ? this.brain.buildReflection(userMessage, recentToolNames, iteration, maxIter)
        : buildReflectionPrompt(userMessage, executedToolCalls, iteration, maxIter);

      const resultsBlock = toolResultsSummary
        .map(r => `## ${r.name}\n${r.content}`)
        .join('\n\n');
      const reflectionContent = `[Tool Results:\n${resultsBlock}${stagnationWarning}\n\n${reflectionText}]`;

      // Include screenshot images in the reflection message for vision-capable models (OpenRouter path)
      // Evict old screenshots first: keep only the most recent to avoid blowing context
      if (screenshotImages.length > 1) {
        screenshotImages.splice(0, screenshotImages.length - 1);
      }
      if (screenshotImages.length > 0) {
        loopMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: reflectionContent },
            ...screenshotImages,
          ],
        });
      } else {
        loopMessages.push({ role: 'user', content: reflectionContent });
      }

      // Homeostasis: dispatch corrective actions mid-loop
      if (this.homeostasisController) {
        try {
          const hoState = this.homeostasisController.check();
          for (const action of hoState.correctiveActions) {
            if (action.type === 'compress_memory' && action.urgency > 0.5) {
              logger.debug({ urgency: action.urgency }, 'homeostasis: compress_memory action active (openrouter)');
            }
          }
        } catch { /* non-fatal */ }
      }

      // Track iteration state for per-iteration model selection
      prevIterToolCount = response.toolCalls?.length ?? 0;
      iterHadErrors = toolResultsSummary.some(r => r.content.startsWith('Error') || r.content.includes('failed'));

      // Mid-loop context budget check
      iterationsSinceSummarize++;
      const utilizationPct = totalInputTokens / contextLimit;
      if (utilizationPct >= 0.7) {
        logger.warn(`[orchestrator] OpenRouter context at ${Math.round(utilizationPct * 100)}% for session ${sessionId}`);
      }
      if (utilizationPct >= 0.6 && iterationsSinceSummarize >= 2 && loopMessages.length > 6) {
        const midBudget = new ContextBudget(contextLimit, 4096);
        midBudget.setSystemPrompt(systemPrompt);
        const summarized = midBudget.summarizeAndTrim(loopMessages as Array<{ role: string; content: string | unknown[] }>);
        if (summarized.length < loopMessages.length) {
          logger.info(`[orchestrator] OpenRouter mid-loop summarization: ${loopMessages.length} → ${summarized.length} messages`);
          loopMessages.length = 0;
          loopMessages.push(...(summarized as OllamaMessage[]));
          iterationsSinceSummarize = 0;
        }
      }
    }

    // WISDOM: Completion validation — seek wisdom before finalizing complex tasks
    if (this.brain && enriched.planFirst && fullContent.length > 200) {
      try {
        const toolSummary = [...executedToolCalls.entries()]
          .map(([k, v]) => `${k}: ${v.success ? 'OK' : 'FAILED'}`)
          .join('\n');
        const wisdomResult = await this.brain.seekWisdom({
          userMessage,
          toolHistory: toolSummary,
          currentContent: fullContent.slice(0, 2000),
          systemContext: '',
        }, 'validation');
        if (wisdomResult.guidance && !wisdomResult.guidance.toUpperCase().startsWith('PROCEED')) {
          yield { type: 'text', content: `\n\n*Strategic review: ${wisdomResult.guidance}*` };
        }
      } catch { /* non-fatal */ }
    }

    // Save turn context
    const turnMessages = buildOllamaTurnMessages(userMessage, loopMessages, turnStartIndex, fullContent);
    await saveToSession(this.sessionDeps, sessionId, turnMessages, userMessage.slice(0, 100));

    if (fullContent) {
      persistExchange(this.sessionDeps, sessionId, userMessage, fullContent, {
        title: userMessage.slice(0, 100),
        extractionDeps: { anthropic: this.anthropic, modelRouter: this.modelRouter },
      }).catch((err) => {
        logger.warn(`[orchestrator] OpenRouter conversation persistence failed: ${err}`);
      });
    }

    this.exchangeCount++;
    if (this.exchangeCount % 3 === 0 && fullContent) {
      extractOrchestratorMemory(this.memoryDeps, sessionId, userMessage, fullContent).catch((err) => {
        logger.error(`[orchestrator] OpenRouter memory extraction failed: ${err}`);
      });
    }

    // Ambient wiki curation (fire-and-forget, every turn)
    if (fullContent) {
      const curatedInTurn = executedToolCalls.has('wiki_write_page');
      reflectOnWikiOpportunities(
        { modelRouter: this.modelRouter, toolCtx: this.buildToolCtx(sessionId) },
        userMessage,
        fullContent,
        { skipIfCuratedInTurn: curatedInTurn },
      ).catch((err) => {
        logger.warn(`[orchestrator] OpenRouter wiki reflection failed: ${err}`);
      });
    }

    // Goal checkpoint extraction (fire-and-forget, every exchange)
    if (fullContent) {
      const goalDeps: GoalCheckpointDeps = { db: this.db, workspaceId: this.workspaceId, modelRouter: this.modelRouter };
      const conversationId = sessionId; // session = conversation for local
      extractGoalCheckpoints(goalDeps, conversationId, userMessage, fullContent, this.exchangeCount).catch(() => {});
    }

    // NOTE: trackSkillUsage() removed — see the comment further up
    // at the Anthropic-path call site. Code skills track success/fail
    // via runtime-skill-metrics.ts on every tool dispatch.

    await this.brain?.flush();

    yield {
      type: 'done',
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      traceId,
    };
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

  private async *runOllamaToolLoop(
    userMessage: string,
    sessionId: string,
    provider: ModelProvider & { createMessageWithTools: NonNullable<ModelProvider['createMessageWithTools']> },
    options?: ChannelChatOptions,
    seedMessages?: MessageParam[],
  ): AsyncGenerator<OrchestratorEvent> {
    // Generate trace ID for this Ollama orchestrator turn
    const ollamaTraceId = crypto.randomUUID();

    // Classify intent for Ollama path (reduces prompt size for small models)
    const previousIntent = this.lastIntentBySession.get(sessionId);
    const classified = classifyIntent(userMessage, previousIntent);
    this.lastIntentBySession.set(sessionId, classified);
    yield { type: 'status', message: classified.statusLabel };

    // Auto-activate browser when intent is 'browser' (skip two-step gateway for small models)
    const browserPreActivated = classified.sections.has('browser') && classified.intent === 'browser';
    // Reuse existing browser from previous turn if still active
    if (this.browserService && !this.browserService.isActive()) {
      yield { type: 'status', message: '[debug] Browser process died, will relaunch if needed' };
      logger.debug('[browser] Browser process no longer active — nullifying (ollama)');
      this.browserService = null;
      this.browserActivated = false;
      this.syncOrganToBody();
    }
    if (browserPreActivated && !this.browserActivated) {
      logger.debug(`[browser] Pre-activating browser (ollama) — target: ${this.browserTarget}`);
      await this.activateBrowser();
    }

    // Auto-activate desktop when intent is 'desktop' (skip two-step gateway for small models)
    const desktopPreActivated = classified.sections.has('desktop') && classified.intent === 'desktop';
    if (desktopPreActivated && !this.desktopActivated) {
      yield { type: 'status', message: '[debug] Desktop control launching (pre-activation)' };
      logger.debug('[desktop] Pre-activating desktop control (ollama)');
      this.desktopService = new LocalDesktopService({ chromeProfileAliases: this.config.chromeProfileAliases });
      this.desktopActivated = true;
      this.syncOrganToBody();
    }

    // Determine model capability tier for prompt/tool selection
    const device = detectDevice();
    const tqBitsToolLoop = this.config.getTurboQuantTierBits();
    const numCtx = getWorkingNumCtx(this.orchestratorModel || '', undefined, device, tqBitsToolLoop);
    const paramTier = getParameterTier(this.orchestratorModel || '');
    const modelEntry = MODEL_CATALOG.find(m => m.tag === (this.orchestratorModel || ''));
    const modelSizeGB = modelEntry?.sizeGB ?? 2.5;
    const priorityLimit = getToolPriorityLimit(modelSizeGB, numCtx);

    // Build prompt tier-aware: micro models get bare skeleton, small get compact, medium+ get full
    const initialPromptMode: boolean | 'micro' = paramTier === 'micro' ? 'micro' : paramTier === 'small' ? true : false;
    const ollamaDisplayLayout = this.desktopService ? buildDisplayLayout(this.desktopService.getScreenInfo().displays) : undefined;
    const ollamaHasMcpTools = this.mcp.hasTools();
    let { staticPart: ollamaStatic, dynamicPart: ollamaDynamic } = await buildTargetedPrompt(this.promptDeps, userMessage, classified.sections, browserPreActivated || this.browserActivated, options?.platform, desktopPreActivated || this.desktopActivated, initialPromptMode, ollamaDisplayLayout, ollamaHasMcpTools);
    let systemPrompt = ollamaStatic + '\n\n' + ollamaDynamic;
    if (initialPromptMode) {
      logger.debug(`[orchestrator] Model tier: ${paramTier} (${modelSizeGB}GB) → ${initialPromptMode === 'micro' ? 'micro' : 'compact'} prompt (${estimateTokens(systemPrompt)} tokens)`);
    }

    // Body Awareness + System Warnings for Ollama path (same as Anthropic path)
    const ollamaProprio = this.brain?.getProprioception();
    if (ollamaProprio && ollamaProprio.organs.length > 0) {
      const activeOrgans = ollamaProprio.organs.filter(o => o.health !== 'dormant');
      if (activeOrgans.length > 0) {
        const degraded = activeOrgans.filter(o => o.health === 'degraded' || o.health === 'failed');
        const lines = [`Active capabilities: ${activeOrgans.map(o => `${o.name} (${o.health})`).join(', ')}`];
        if (degraded.length > 0) lines.push(`Degraded: ${degraded.map(o => `${o.name} is ${o.health}`).join(', ')}`);
        systemPrompt += `\n\n## Body Awareness\n${lines.join('\n')}`;
      }
    }
    const ollamaWarnings = this.brain?.workspace.getConscious(3, { types: ['failure', 'warning'], minSalience: 0.5 }) ?? [];
    if (ollamaWarnings.length > 0) {
      systemPrompt += `\n\n## System Warnings\n${ollamaWarnings.map(w => w.content).join('\n')}`;
    }

    // Convert Anthropic tool definitions to OpenAI format (with priority filtering)
    const anthropicTools = await this.getTools(options, browserPreActivated || this.browserActivated, classified.sections, desktopPreActivated || this.desktopActivated, priorityLimit, userMessage);
    let openaiTools = convertToolsToOpenAI(anthropicTools);
    if (priorityLimit < 3) {
      logger.debug(`[orchestrator] Progressive tool revelation: P${priorityLimit} limit, ${anthropicTools.length} tools (model: ${modelSizeGB}GB, ctx: ${numCtx})`);
    }

    const history = seedMessages ? [...seedMessages] : await loadHistory(this.sessionDeps, sessionId);
    history.push({ role: 'user', content: userMessage });
    let toolTokenCount = estimateToolTokens(openaiTools);
    const systemTokens = estimateTokens(systemPrompt);
    const historyBudget = numCtx - systemTokens - toolTokenCount - 4096;

    if (historyBudget < 2000) {
      // Tight context: compress tool descriptions first (cheapest win)
      openaiTools = compressToolsForContext(openaiTools);
      toolTokenCount = estimateToolTokens(openaiTools);
      logger.debug(`[orchestrator] Compressed tool descriptions (${anthropicTools.length} tools, ${toolTokenCount} tokens)`);

      // Still tight: rebuild system prompt in compact mode
      const compactHistoryBudget = numCtx - estimateTokens(systemPrompt) - toolTokenCount - 4096;
      if (compactHistoryBudget < 1500) {
        const compact = await buildTargetedPrompt(this.promptDeps, userMessage, classified.sections, browserPreActivated || this.browserActivated, options?.platform, desktopPreActivated || this.desktopActivated, true, ollamaDisplayLayout, ollamaHasMcpTools);
        ollamaStatic = compact.staticPart;
        ollamaDynamic = compact.dynamicPart;
        systemPrompt = ollamaStatic + '\n\n' + ollamaDynamic;
        logger.debug(`[orchestrator] Switched to compact system prompt (${estimateTokens(systemPrompt)} tokens)`);
      }
    }

    // Token-aware truncation using ContextBudget (now includes tool tokens)
    const budget = new ContextBudget(numCtx, 4096);
    budget.setSystemPrompt(systemPrompt);
    budget.setToolTokens(toolTokenCount);
    const truncatedHistory = budget.summarizeAndTrim(history);
    const budgetState = budget.getState();
    logger.debug(`[orchestrator] Context budget: ${budgetState.utilizationPct}% used | sys:${budgetState.systemPromptTokens} tools:${budgetState.toolTokens} hist:${budgetState.historyTokens} msgs:${budgetState.messageCount} | capacity:${budgetState.modelCapacity} available:${budgetState.availableTokens}`);
    const loopMessages: OllamaMessage[] = [];
    for (const m of truncatedHistory) {
      if (typeof m.content === 'string') {
        loopMessages.push({ role: m.role as 'user' | 'assistant', content: m.content });
      } else if (Array.isArray(m.content)) {
        const blocks = m.content as ContentBlockParam[];
        const hasToolUse = blocks.some(b => b.type === 'tool_use');
        const hasToolResult = blocks.some(b => b.type === 'tool_result');

        if (hasToolUse && m.role === 'assistant') {
          // Convert tool_use blocks to Ollama tool_calls format
          const textParts = blocks.filter(b => b.type === 'text').map(b => (b as TextBlockParam).text);
          const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => {
            const tu = b as ContentBlockParam & { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
            return { id: tu.id, type: 'function' as const, function: { name: tu.name, arguments: JSON.stringify(tu.input) } };
          });
          loopMessages.push({ role: 'assistant', content: textParts.join(''), tool_calls: toolCalls });
        } else if (hasToolResult && m.role === 'user') {
          // Convert tool_result blocks to Ollama tool messages
          for (const b of blocks) {
            if (b.type === 'tool_result') {
              const tr = b as ToolResultBlockParam;
              loopMessages.push({
                role: 'tool',
                content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
                tool_call_id: tr.tool_use_id,
              });
            }
          }
        } else {
          // Fallback: stringify complex content
          loopMessages.push({ role: m.role as 'user' | 'assistant', content: JSON.stringify(m.content) });
        }
      }
    }

    // Track where new messages start (for saving turn context)
    const ollamaTurnStartIndex = loopMessages.length;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let fullContent = '';
    const executedToolCallsOllama = new Map<string, ToolResult>();

    let consecutiveParseErrors = 0;
    let toolLoopAborted = false;
    const ollamaToolCallHashes: string[] = [];
    const ollamaSessionToolNames: string[] = [];
    const ollamaMaxIter = MODE_MAX_ITERATIONS[classified.mode] ?? MAX_ITERATIONS;
    // Per-turn consecutive failure breaker (parity with Anthropic / OpenRouter loops).
    // Catches the same fast pathology where the model gets confused and calls
    // a failing tool 4-5 times in a row.
    const consecutiveBreaker = new ConsecutiveToolBreaker();

    // Cast provider for streaming access — safe because we only enter this
    // method when provider.name === 'ollama'
    const ollamaProvider = provider as unknown as OllamaProvider;

    for (let iteration = 0; iteration < ollamaMaxIter; iteration++) {
      // Evict old screenshots: keep only the most recent image to avoid
      // blowing the context window on multi-step desktop workflows.
      // Each base64 screenshot is ~40-50K tokens.
      let lastImageIdx = -1;
      for (let i = loopMessages.length - 1; i >= 0; i--) {
        const c = loopMessages[i].content;
        if (Array.isArray(c) && c.some(p => p.type === 'image_url')) {
          if (lastImageIdx === -1) {
            lastImageIdx = i; // keep this one
          } else {
            // Strip image parts, keep text
            loopMessages[i].content = c.filter(p => p.type !== 'image_url');
            // If only text parts remain and there's exactly one, collapse to string
            const remaining = loopMessages[i].content as Array<{ type: string; text?: string }>;
            if (remaining.length === 1 && remaining[0].type === 'text') {
              loopMessages[i].content = remaining[0].text || '';
            }
          }
        }
      }

      // Compact stale tool results before each model call.
      compactStaleOpenAIToolResults(loopMessages as Array<{ role: string; content: unknown }>);

      // Hard turn-level token budget guard. For Ollama, numCtx is the
      // hard ceiling (model-specific); reserve 4096 for output and
      // break early if projected input exceeds 75% of usable budget.
      {
        const staticTokensEst = estimateTokens(systemPrompt) + toolTokenCount;
        const messageTokensEst = estimateMessagesTokens(loopMessages);
        const verdict = checkTurnTokenBudget({
          contextLimit: numCtx,
          reserveForOutput: 4096,
          staticTokens: staticTokensEst,
          messageTokens: messageTokensEst,
          iteration,
          maxIterations: ollamaMaxIter,
        });
        if (verdict.shouldWarn) {
          logger.warn(`[orchestrator] Ollama turn budget at ${Math.round(verdict.utilization * 100)}% (iter ${iteration}/${ollamaMaxIter}) for session ${sessionId}`);
        }
        if (verdict.shouldBreak) {
          const exitMsg = buildBudgetExitMessage({
            iteration,
            toolsExecuted: executedToolCallsOllama.size,
            reason: verdict.reason,
          });
          yield { type: 'text', content: exitMsg };
          fullContent += exitMsg;
          break;
        }
      }

      let response: ModelResponseWithTools;
      // Bug #6: per-iteration timeout for the streaming Ollama tool loop.
      const ollamaStreamTimer = createTimeoutController(
        `Ollama stream (${this.orchestratorModel || 'default'}, iter ${iteration})`,
        MODEL_CALL_TIMEOUT_MS,
      );
      try {
        // Stream tokens — createMessageWithToolsStreaming yields text tokens
        // only when no tool_calls deltas are detected, then returns the final response.
        const thinkFilter = new ThinkTagFilter();
        const streamMsgParams = {
          model: this.orchestratorModel || undefined,
          system: systemPrompt,
          messages: loopMessages.map(m => ({
            role: m.role,
            content: m.content,
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          })),
          maxTokens: 4096,
          temperature: 0.5,
          tools: openaiTools,
          numCtx,
          signal: ollamaStreamTimer.signal,
        };
        const stream = ollamaProvider.createMessageWithToolsStreaming(streamMsgParams);
        let streamResult: IteratorResult<{ type: 'token'; content: string }, ModelResponseWithTools>;
        while (true) {
          streamResult = await stream.next();
          if (streamResult.done) {
            response = streamResult.value;
            break;
          }
          // Filter <think> tags and yield text tokens
          const filtered = thinkFilter.feed(streamResult.value.content);
          if (filtered) {
            yield { type: 'text', content: filtered };
          }
        }
        const flushed = thinkFilter.flush();
        if (flushed) {
          yield { type: 'text', content: flushed };
        }
      } catch (err) {
        if (err instanceof TimeoutError) {
          logger.warn({ err: err.message, model: this.orchestratorModel, iteration }, '[orchestrator] Ollama model call timed out');
          yield { type: 'text', content: `Model call timed out after ${Math.round(err.elapsedMs / 1000)}s. Try again with a smaller prompt or a faster model.` };
          throw err;
        }
        // If tool calling fails (unsupported model), fall back to streaming
        // text-only. The fallback gets its own timer below; the outer
        // ollamaStreamTimer is cleared by the outer finally.
        if (iteration === 0) {
          const fallbackTimer = createTimeoutController(
            `Ollama fallback stream (${this.orchestratorModel || 'default'})`,
            MODEL_CALL_TIMEOUT_MS,
          );
          try {
            const thinkFilter = new ThinkTagFilter();
            const fallbackStream = ollamaProvider.createMessageStreaming({
              system: systemPrompt,
              messages: loopMessages.map(m => ({
                role: m.role === 'tool' ? 'user' : m.role,
                content: m.content,
              })),
              maxTokens: 4096,
              temperature: 0.5,
              numCtx,
              signal: fallbackTimer.signal,
            });
            let fallbackResult: IteratorResult<{ type: 'token'; content: string }, ModelResponse>;
            let textResponse: ModelResponse | undefined;
            while (true) {
              fallbackResult = await fallbackStream.next();
              if (fallbackResult.done) {
                textResponse = fallbackResult.value;
                break;
              }
              const filtered = thinkFilter.feed(fallbackResult.value.content);
              if (filtered) {
                yield { type: 'text', content: filtered };
              }
            }
            const flushed = thinkFilter.flush();
            if (flushed) {
              yield { type: 'text', content: flushed };
            }
            const resp = textResponse!;
            await saveToSession(this.sessionDeps, sessionId, [
              { role: 'user', content: userMessage },
              { role: 'assistant', content: stripThinkTags(resp.content) },
            ], userMessage.slice(0, 100));
            this.exchangeCount++;
            yield { type: 'done', inputTokens: resp.inputTokens, outputTokens: resp.outputTokens };
            return;
          } catch (fallbackErr) {
            if (fallbackErr instanceof TimeoutError) {
              logger.warn({ err: fallbackErr.message }, '[orchestrator] Ollama fallback stream timed out');
              yield { type: 'text', content: `Model fallback call timed out after ${Math.round(fallbackErr.elapsedMs / 1000)}s.` };
            }
            throw fallbackErr;
          } finally {
            fallbackTimer.cancel();
          }
        }
        throw err;
      } finally {
        ollamaStreamTimer.cancel();
      }

      totalInputTokens += response.inputTokens;
      totalOutputTokens += response.outputTokens;

      const hasToolCalls = response.toolCalls && response.toolCalls.length > 0;

      // Text was already streamed token-by-token above (when no tool calls detected).
      // If there ARE tool calls, the streaming method already suppressed text output.
      // Track fullContent for session saving.
      if (response.content && !hasToolCalls) {
        const cleaned = stripThinkTags(response.content);
        if (cleaned) {
          fullContent += cleaned;
        }
      }

      if (!hasToolCalls) {
        // Check for text-based tool calls before breaking
        const knownToolNames = new Set(openaiTools.map(t => t.function.name));
        const textContent = response.content || '';
        const textParsed = extractToolCallsFromText(textContent, knownToolNames);
        if (textParsed.toolCalls.length > 0) {
          // Synthesize OpenAI-style tool calls from text-based calls
          const synthesizedToolCalls = textParsed.toolCalls.map((tc, i) => ({
            id: `text_call_${i}_${Date.now()}`,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
          // Replace yielded text with cleaned version
          if (textParsed.cleanedText !== textContent) {
            fullContent = fullContent.slice(0, fullContent.length - (textContent.length)) + textParsed.cleanedText;
          }
          // Re-assign response fields and fall through to the normal tool execution path
          response.toolCalls = synthesizedToolCalls;
        } else {
          break;
        }
      }

      // Append assistant message with tool calls
      loopMessages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: tc.function,
        })),
      });

      // Parse all tool calls first, collecting valid requests and handling errors
      const toolResultsSummary: { name: string; content: string }[] = [];
      const screenshotImages: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
      const validRequests: { req: ToolCallRequest; toolCall: typeof response.toolCalls[0] }[] = [];

      for (let toolCall of response.toolCalls) {
        // Repair malformed tool calls from small models
        const repairResult = repairToolCall(toolCall, openaiTools);
        if (repairResult.repairs.length > 0) {
          logger.info(`[LocalOrchestrator] Tool call repaired: ${repairResult.repairs.join(', ')}`);
          toolCall = repairResult.toolCall;
        }
        if (repairResult.error) {
          logger.warn(`[LocalOrchestrator] Tool call repair failed: ${repairResult.error}`);
          loopMessages.push({ role: 'tool', content: repairResult.error, tool_call_id: toolCall.id });
          toolResultsSummary.push({ name: toolCall.function.name || 'unknown_tool', content: repairResult.error });
          consecutiveParseErrors++;
          if (consecutiveParseErrors >= 3) {
            fullContent += '\n\nI had trouble using the tools. Let me answer directly instead.';
            yield { type: 'text', content: '\n\nI had trouble using the tools. Let me answer directly instead.' };
            toolLoopAborted = true;
            break;
          }
          continue;
        }

        const toolName = toolCall.function.name;

        if (!toolName) {
          const errorMsg = 'Tool call missing function name. Provide a valid tool name.';
          logger.warn(`[LocalOrchestrator] ${errorMsg}`);
          loopMessages.push({ role: 'tool', content: errorMsg, tool_call_id: toolCall.id });
          toolResultsSummary.push({ name: 'unknown_tool', content: errorMsg });
          continue;
        }

        const parsed = parseToolArguments(toolCall.function.arguments, toolName);
        if (parsed.error) {
          logger.warn(`[LocalOrchestrator] ${parsed.error}`);
          loopMessages.push({ role: 'tool', content: parsed.error, tool_call_id: toolCall.id });
          toolResultsSummary.push({ name: toolName, content: parsed.error });
          consecutiveParseErrors++;
          if (consecutiveParseErrors >= 3) {
            fullContent += '\n\nI had trouble using the tools. Let me answer directly instead.';
            yield { type: 'text', content: '\n\nI had trouble using the tools. Let me answer directly instead.' };
            toolLoopAborted = true;
            break;
          }
          continue;
        }

        let toolInput = parsed.args;
        if (options?.transformToolInput) {
          toolInput = options.transformToolInput(toolName, toolInput);
        }

        validRequests.push({ req: { id: toolCall.id, name: toolName, input: toolInput }, toolCall });
      }

      if (toolLoopAborted) break;

      // Execute valid tool calls in parallel
      if (validRequests.length > 0) {
        const execCtx = this.buildToolExecCtx(executedToolCallsOllama, options, sessionId);
        const batchGen = executeToolCallsBatch(validRequests.map(v => v.req), execCtx);
        let outcomes: import('./tool-executor.js').ToolCallOutcome[];
        for (;;) {
          const { value, done } = await batchGen.next();
          if (done) { outcomes = value; break; }
          yield value;
        }

        for (let i = 0; i < outcomes.length; i++) {
          const outcome = outcomes[i];
          const { req, toolCall } = validRequests[i];

          // Handle browser activation: create service and swap OpenAI tools
          if (outcome.toolsModified && outcome.toolName === 'request_browser' && !this.browserActivated) {
            await this.activateBrowser();
            const browserOpenAI = convertToolsToOpenAI(BROWSER_TOOL_DEFINITIONS);
            openaiTools = openaiTools.filter((t) => t.function.name !== 'request_browser');
            openaiTools = [...openaiTools, ...browserOpenAI];
          }

          // Handle desktop activation: same pattern as browser
          if (outcome.toolsModified && outcome.toolName === 'request_desktop' && !this.desktopActivated) {
            this.desktopService = new LocalDesktopService({ chromeProfileAliases: this.config.chromeProfileAliases });
            this.desktopActivated = true;
            const desktopOpenAI = convertToolsToOpenAI(DESKTOP_TOOL_DEFINITIONS);
            openaiTools = openaiTools.filter((t) => t.function.name !== 'request_desktop');
            openaiTools = [...openaiTools, ...desktopOpenAI];
          }

          consecutiveParseErrors = 0;

          // Brain: record tool execution (predict → update → embody)
          this.brain?.recordToolExecution(req.name, req.input, outcome.result.success);

          // Affect: process tool result -> emotional response (Damasio) — Ollama path parity
          if (this.affectEngine) {
            const isNovel = this.brain?.predictiveEngine?.isNovel(req.name) ?? false;
            this.affectEngine.processToolResult(req.name, userMessage, outcome.result.success, isNovel).catch(() => {});
          }

          // Endocrine: tool results trigger hormone responses (Spinoza) — Ollama path parity
          if (this.endocrineSystem) {
            if (outcome.result.success) {
              this.endocrineSystem.stimulate({ hormone: 'dopamine', delta: 0.05, source: 'tool_execution', reason: `${req.name} succeeded` });
            } else {
              this.endocrineSystem.stimulate({ hormone: 'cortisol', delta: 0.1, source: 'tool_execution', reason: `${req.name} failed` });
            }
          }

          // Habit: record execution for matching habits (Aristotle's hexis) — Ollama path parity
          if (this.habitEngine) {
            const matchingHabits = this.habitEngine.checkCues(req.name, ollamaSessionToolNames);
            for (const match of matchingHabits) {
              this.habitEngine.recordExecution(match.habit.id, outcome.result.success).catch(() => {});
            }
          }

          ollamaSessionToolNames.push(req.name);

          // Per-turn consecutive failure tracking (parity with Anthropic / OpenRouter).
          // The Ollama path doesn't currently feed the global circuitBreaker either,
          // but the per-turn breaker is enough to catch in-turn loops which is the
          // failure mode that actually burns budget here.
          const consecutiveDecision = consecutiveBreaker.record(
            outcome.toolName,
            !outcome.isError,
            outcome.isError ? outcome.resultContent : undefined,
          );

          // Ollama format: use text resultContent (no image blocks)
          let toolMessageContent = outcome.resultContent;
          if (consecutiveDecision === 'nudge') {
            toolMessageContent = `${toolMessageContent}${consecutiveBreaker.buildNudgeMessage(outcome.toolName)}`;
          }
          loopMessages.push({ role: 'tool', content: toolMessageContent, tool_call_id: toolCall.id });
          toolResultsSummary.push({ name: req.name, content: toolMessageContent });

          // Collect base64 images from formattedBlocks for vision-capable models
          if (modelEntry?.vision && outcome.formattedBlocks) {
            for (const block of outcome.formattedBlocks) {
              if (block.type === 'image' && 'source' in block) {
                const src = (block as { type: 'image'; source: { type: string; media_type: string; data: string } }).source;
                if (src.type === 'base64' && src.data) {
                  screenshotImages.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } });
                }
              }
            }
          }
        }

        // Hard-abort if any tool just hit the consecutive-failure cap.
        if (consecutiveBreaker.isAborted()) {
          const abortMsg = consecutiveBreaker.buildAbortMessage();
          yield { type: 'text', content: abortMsg };
          fullContent += abortMsg;
          toolLoopAborted = true;
          break;
        }
      }

      // Track tool call hashes for stagnation detection via predictive engine (Ollama path)
      for (const { req } of validRequests) {
        ollamaToolCallHashes.push(hashToolCall(req.name, req.input));
      }

      // Brain: inject enriched stagnation warning (Ollama path)
      let stagnationWarning = '';
      if (this.brain?.isStagnating()) {
        stagnationWarning = `\n\n${this.brain.buildStagnationWarning()}`;
      }

      // Dynamic re-anchoring with progress-aware reflection.
      // Embed actual tool results as fallback for models that don't understand role:'tool'.
      const resultsBlock = toolResultsSummary
        .map(r => `## ${r.name}\n${r.content}`)
        .join('\n\n');

      const ollamaReflection = buildReflectionPrompt(userMessage, executedToolCallsOllama, iteration, ollamaMaxIter);
      const reflectionText = `[Tool Results:\n${resultsBlock}${stagnationWarning}\n\n${ollamaReflection}]`;

      // Include screenshot images in the reflection message for vision-capable models
      if (screenshotImages.length > 0) {
        loopMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: reflectionText },
            ...screenshotImages,
          ],
        });
        screenshotImages.length = 0;
      } else {
        loopMessages.push({ role: 'user', content: reflectionText });
      }
    }

    // Save to session (full turn with tool context, converted to MessageParam format)
    const ollamaTurnMessages = buildOllamaTurnMessages(userMessage, loopMessages, ollamaTurnStartIndex, fullContent);
    await saveToSession(this.sessionDeps, sessionId, ollamaTurnMessages, userMessage.slice(0, 100));

    // Persist to append-only conversation history + schedule idle extraction (fire-and-forget)
    if (fullContent) {
      persistExchange(this.sessionDeps, sessionId, userMessage, fullContent, {
        title: userMessage.slice(0, 100),
        extractionDeps: { anthropic: this.anthropic, modelRouter: this.modelRouter },
      }).catch((err) => {
        logger.warn(`[LocalOrchestrator] Conversation persistence failed: ${err}`);
      });
    }

    // Extract orchestrator memory every 3rd exchange (fire-and-forget, parity with Claude path)
    this.exchangeCount++;
    if (this.exchangeCount % 3 === 0 && fullContent) {
      extractOrchestratorMemory(this.memoryDeps, sessionId, userMessage, fullContent).catch((err) => {
        logger.error(`[LocalOrchestrator] Memory extraction failed: ${err}`);
      });
    }

    // Ambient wiki curation (fire-and-forget, parity with Claude/OpenRouter paths)
    if (fullContent) {
      const curatedInTurn = executedToolCallsOllama.has('wiki_write_page');
      reflectOnWikiOpportunities(
        { modelRouter: this.modelRouter, toolCtx: this.buildToolCtx(sessionId) },
        userMessage,
        fullContent,
        { skipIfCuratedInTurn: curatedInTurn },
      ).catch((err) => {
        logger.warn(`[LocalOrchestrator] Wiki reflection failed: ${err}`);
      });
    }

    // Flush brain experience stream (Ollama path)
    await this.brain?.flush();

    yield {
      type: 'done',
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      traceId: ollamaTraceId,
    };
  }

}
