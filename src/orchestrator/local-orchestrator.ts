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
import { ORCHESTRATOR_TOOL_DEFINITIONS, FILESYSTEM_TOOL_DEFINITIONS, BASH_TOOL_DEFINITIONS, filterToolsByIntent, getToolPriorityLimit, type IntentSection } from './tool-definitions.js';
import { invalidateFileAccessCache } from './tools/filesystem.js';
import { getWorkingNumCtx, MODEL_CATALOG, getParameterTier } from '../lib/ollama-models.js';
import { detectDevice } from '../lib/device-info.js';
import { ContextBudget, estimateTokens, estimateToolTokens } from './context-budget.js';
import type { LocalToolContext, ToolResult } from './local-tool-types.js';
import type { ChannelRegistry } from '../integrations/channel-registry.js';
import type { ControlPlaneClient } from '../control-plane/client.js';
import { type ModelRouter, type ModelResponse, type ModelResponseWithTools, type ModelProvider, OllamaProvider } from '../execution/model-router.js';
import { convertToolsToOpenAI, compressToolsForContext } from '../execution/tool-format.js';
import { parseToolArguments } from '../execution/tool-parse.js';
import { repairToolCall } from './tool-call-repair.js';
import { extractToolCallsFromText } from '../execution/text-tool-parse.js';
import type { ScraplingService } from '../execution/scrapling/index.js';
import type { McpServerConfig } from '../mcp/types.js';
import { McpClientManager, type ElicitationHandler } from '../mcp/client.js';
import {
  REQUEST_BROWSER_TOOL,
  BROWSER_TOOL_DEFINITIONS,
} from '../execution/browser/browser-tools.js';
import { LocalBrowserService } from '../execution/browser/local-browser.service.js';
import {
  REQUEST_DESKTOP_TOOL,
  DESKTOP_TOOL_DEFINITIONS,
} from '../execution/desktop/desktop-tools.js';
import { LocalDesktopService } from '../execution/desktop/local-desktop.service.js';
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
  buildAnthropicTurnMessages,
  buildOllamaTurnMessages,
  extractOrchestratorMemory,
  type OllamaMessage,
  type SessionDeps,
  type MemoryExtractionDeps,
} from './session-store.js';
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
import { CircuitBreaker } from './error-recovery.js';
import { ToolCache } from './tool-cache.js';
import { runSubOrchestrator, getFocusSections, type SubOrchestratorResult } from './sub-orchestrator.js';
import { logger } from '../lib/logger.js';
import { hashToolCall, detectStagnation, STAGNATION_PROMPT } from '../lib/stagnation.js';
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
  private dataDir: string;
  private browserService: LocalBrowserService | null = null;
  private browserActivated = false;
  private desktopService: LocalDesktopService | null = null;
  private desktopActivated = false;
  private onScheduleChange?: () => void;
  private exchangeCount = 0;
  private pendingPermissions = new Map<string, (granted: boolean) => void>();
  private pendingCostApprovals = new Map<string, (approved: boolean) => void>();
  private skipMediaCostConfirmation = false;
  private pendingElicitations = new Map<string, (response: Record<string, unknown> | null) => void>();
  private lastIntentBySession = new Map<string, ClassifiedIntent>();
  private circuitBreaker = new CircuitBreaker();
  private toolCache = new ToolCache();
  private mcpClients: McpClientManager | null = null;
  private mcpServers: McpServerConfig[];

  private get sessionDeps(): SessionDeps {
    return { db: this.db, workspaceId: this.workspaceId };
  }

  private get memoryDeps(): MemoryExtractionDeps {
    return { db: this.db, workspaceId: this.workspaceId, anthropicApiKey: this.anthropicApiKey, anthropic: this.anthropic, modelRouter: this.modelRouter };
  }

  private get browserState(): BrowserState {
    return { service: this.browserService, activated: this.browserActivated, headless: this.browserHeadless, dataDir: this.dataDir };
  }

  private get desktopState(): DesktopState {
    return { service: this.desktopService, activated: this.desktopActivated, dataDir: this.dataDir };
  }

  private buildToolCtx(): LocalToolContext {
    return {
      db: this.db,
      workspaceId: this.workspaceId,
      engine: this.engine,
      channels: this.channels,
      controlPlane: this.controlPlane,
      scraplingService: this.scraplingService,
      anthropicApiKey: this.anthropicApiKey,
      modelRouter: this.modelRouter,
      onScheduleChange: this.onScheduleChange,
      workingDirectory: this.workingDirectory || undefined,
    };
  }

  private buildToolExecCtx(executedToolCalls: Map<string, ToolResult>, options?: ChannelChatOptions): ToolExecutionContext {
    return {
      toolCtx: this.buildToolCtx(),
      executedToolCalls,
      browserState: this.browserState,
      desktopState: this.desktopState,
      waitForPermission: (requestId: string) => this.waitForPermission(requestId),
      addAllowedPath: (path: string) => this.addAllowedPath(path),
      options,
      circuitBreaker: this.circuitBreaker,
      toolCache: this.toolCache,
      delegateSubtask: (prompt: string, focus: string) => this.runDelegateSubtask(prompt, focus, options),
      mcpClients: this.mcpClients,
      waitForCostApproval: (id: string) => this.waitForCostApproval(id),
      skipMediaCostConfirmation: this.skipMediaCostConfirmation,
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
  ) {
    this.db = db;
    this.engine = engine;
    this.workspaceId = workspaceId;
    this.anthropicApiKey = anthropicApiKey;
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey, timeout: 120_000 });
    this.channels = channels;
    this.controlPlane = controlPlane ?? null;
    this.modelRouter = modelRouter ?? null;
    this.scraplingService = scraplingService;
    this.orchestratorModel = orchestratorModel || '';
    this.workingDirectory = workingDirectory || '';
    this.browserHeadless = browserHeadless ?? false;
    this.dataDir = dataDir || '';
    this.mcpServers = mcpServers || [];
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
  setModelSource(source: 'local' | 'cloud' | 'auto'): void {
    this.modelRouter?.setModelSource(source);
  }

  /** Set whether to skip cost confirmation for cloud media tools. */
  setSkipMediaCostConfirmation(skip: boolean): void {
    this.skipMediaCostConfirmation = skip;
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
    }
  }

  /** Close the desktop control service (call from orchestrator cleanup/shutdown). */
  closeDesktop(): void {
    if (this.desktopService) {
      logger.debug('[desktop] closeDesktop() called — closing desktop service');
      this.desktopService.close();
      this.desktopService = null;
      this.desktopActivated = false;
    }
  }

  /** Close MCP client connections (call alongside browser cleanup on shutdown). */
  async closeMcp(): Promise<void> {
    if (this.mcpClients) {
      logger.debug('[mcp] closeMcp() called — closing MCP connections');
      await this.mcpClients.close().catch(() => {});
      this.mcpClients = null;
    }
  }

  /**
   * Ensure MCP clients are connected. Lazy-initializes on first use.
   * When force=true, closes existing connections and reconnects (for crash recovery).
   */
  private async ensureMcpConnected(force = false): Promise<void> {
    if (this.mcpClients && !force) return;

    // Load servers: prefer constructor config, fallback to DB
    let servers = this.mcpServers;
    if (servers.length === 0) {
      try {
        const { data } = await this.db
          .from('runtime_settings')
          .select('value')
          .eq('key', 'global_mcp_servers')
          .maybeSingle();
        if (data) {
          servers = JSON.parse((data as { value: string }).value) as McpServerConfig[];
        }
      } catch {
        // DB not available, skip
      }
    }

    if (servers.length === 0) return;

    if (force && this.mcpClients) {
      await this.mcpClients.close().catch(() => {});
      this.mcpClients = null;
    }

    const onElicitation: ElicitationHandler = async (_serverName, _message, _schema) => {
      const requestId = crypto.randomUUID();
      return new Promise<Record<string, unknown> | null>((resolve) => {
        this.pendingElicitations.set(requestId, resolve);
        // Elicitation requests are surfaced as events — the TUI handles user input
        // For now, auto-decline since we don't have the event channel here
        // The calling code should wire this up via the event stream
        setTimeout(() => {
          if (this.pendingElicitations.has(requestId)) {
            this.pendingElicitations.delete(requestId);
            resolve(null);
          }
        }, 30_000);
      });
    };

    this.mcpClients = await McpClientManager.connect(servers, { onElicitation });
    const toolCount = this.mcpClients.getToolDefinitions().length;
    if (toolCount > 0) {
      logger.info(`[mcp] Orchestrator connected — ${toolCount} tool(s) available`);
    }
  }

  /** Resolve a pending MCP elicitation request. */
  resolveElicitation(requestId: string, response: Record<string, unknown> | null): void {
    const resolve = this.pendingElicitations.get(requestId);
    if (resolve) {
      this.pendingElicitations.delete(requestId);
      resolve(response);
    }
  }

  /** Set the schedule change callback for notifying the scheduler on CRUD. */
  setScheduleChangeCallback(callback: () => void): void {
    this.onScheduleChange = callback;
  }

  /** Resolve a pending permission request. Called by the API route. */
  resolvePermission(requestId: string, granted: boolean): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (resolve) {
      this.pendingPermissions.delete(requestId);
      resolve(granted);
    }
  }

  private waitForPermission(requestId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
    });
  }

  /** Resolve a pending cost approval request. Called by the API route. */
  resolveCostApproval(requestId: string, approved: boolean): void {
    const resolve = this.pendingCostApprovals.get(requestId);
    if (resolve) {
      this.pendingCostApprovals.delete(requestId);
      resolve(approved);
    }
  }

  private waitForCostApproval(requestId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingCostApprovals.set(requestId, resolve);
    });
  }

  private async addAllowedPath(allowedPath: string): Promise<void> {
    await this.db.from('agent_file_access_paths').insert({
      id: crypto.randomUUID(),
      workspace_id: this.workspaceId,
      agent_id: '__orchestrator__',
      path: allowedPath,
    });
    invalidateFileAccessCache();
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
        provider = await this.modelRouter.getProvider('orchestrator');
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
          const numCtx = getWorkingNumCtx(this.orchestratorModel || '', undefined, device);
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
            // Stream tokens incrementally
            const thinkFilter = new ThinkTagFilter();
            const streamParams = {
              system: systemPrompt,
              messages: trimmedMessages,
              maxTokens: 4096,
              temperature: 0.5,
              numCtx,
            };
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
            const resp = finalResponse!;
            await saveToSession(this.sessionDeps, sessionId, [
              { role: 'user', content: userMessage },
              { role: 'assistant', content: stripThinkTags(resp.content) },
            ], userMessage.slice(0, 100));
            this.exchangeCount++;
            yield { type: 'done', inputTokens: resp.inputTokens, outputTokens: resp.outputTokens };
          } else {
            const response = await provider.createMessage({
              system: systemPrompt,
              messages: trimmedMessages,
              maxTokens: 4096,
              temperature: 0.5,
              numCtx,
            });
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
      // Anthropic provider → fall through to the full Anthropic SDK path below
    }

    // Generate trace ID for this orchestrator turn
    const traceId = crypto.randomUUID();

    // Classify intent, inheriting previous intent for confirmations
    const previousIntent = this.lastIntentBySession.get(sessionId);
    const classified = classifyIntent(userMessage, previousIntent);
    const { sections, statusLabel } = classified;
    yield { type: 'status', message: statusLabel };

    // Store for next turn (so confirmations can inherit)
    this.lastIntentBySession.set(sessionId, classified);

    // Auto-activate browser when intent is 'browser' (skip the two-step gateway)
    const browserPreActivated = sections.has('browser') && classified.intent === 'browser';
    // Reuse existing browser from previous turn if still active
    if (this.browserService && !this.browserService.isActive()) {
      yield { type: 'status', message: '[debug] Browser process died, will relaunch if needed' };
      logger.debug('[browser] Browser process no longer active — nullifying');
      this.browserService = null;
      this.browserActivated = false;
    }
    if (browserPreActivated && !this.browserActivated) {
      yield { type: 'status', message: `[debug] Browser launching (pre-activation) — headless: ${this.browserHeadless}` };
      logger.debug(`[browser] Pre-activating browser — headless: ${this.browserHeadless}`);
      this.browserService = new LocalBrowserService({ headless: this.browserHeadless });
      this.browserActivated = true;
    }

    // Auto-activate desktop when intent is 'desktop'
    const desktopPreActivated = sections.has('desktop') && classified.intent === 'desktop';
    if (desktopPreActivated && !this.desktopActivated) {
      yield { type: 'status', message: '[debug] Desktop control launching (pre-activation)' };
      logger.debug('[desktop] Pre-activating desktop control');
      this.desktopService = new LocalDesktopService();
      this.desktopActivated = true;
    }

    // Build targeted system prompt (only fetches context for relevant sections)
    const { staticPart, dynamicPart } = await buildTargetedPrompt(this.promptDeps, userMessage, sections, browserPreActivated || this.browserActivated, options?.platform, desktopPreActivated || this.desktopActivated);

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

    // Build tool list (conditionally includes filesystem tools, filtered by intent for Anthropic)
    const tools = await this.getTools(options, browserPreActivated || this.browserActivated, sections, desktopPreActivated || this.desktopActivated);

    // Intent-aware tool_choice: force tool use for file intent to prevent fabrication
    // Only force on first iteration; subsequent iterations use 'auto'
    let currentToolChoice: { type: 'any' } | { type: 'auto' } = classified.intent === 'file'
      ? { type: 'any' as const }
      : { type: 'auto' as const };

    // Load chat history from session (or use seed messages from cloud proxy)
    const history = seedMessages ? [...seedMessages] : await loadHistory(this.sessionDeps, sessionId);

    // Add user message
    history.push({ role: 'user', content: userMessage });

    // Truncate to last 20 messages
    const loopMessages: MessageParam[] = history.length > 20
      ? history.slice(-20)
      : [...history];

    // Track where new messages start (for saving turn context)
    const turnStartIndex = loopMessages.length;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    let fullContent = '';
    const executedToolCalls = new Map<string, ToolResult>();
    const orchToolCallHashes: string[] = [];
    const maxIter = MODE_MAX_ITERATIONS[classified.mode] ?? MAX_ITERATIONS;

    // Context budget tracking for Anthropic path
    const anthropicContextLimit = CLAUDE_CONTEXT_LIMITS['claude-sonnet-4-5'];
    let iterationsSinceSummarize = 2; // allow summarization from the start

    for (let iteration = 0; iteration < maxIter; iteration++) {
      // Non-streaming: get full response then yield text blocks
      const response = await this.anthropic.messages.create({
        model: this.orchestratorModel || MODEL,
        max_tokens: 4096,
        system: systemBlocks,
        messages: loopMessages,
        tools,
        tool_choice: currentToolChoice,
        temperature: 0.5,
      });

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
            const execCtx = this.buildToolExecCtx(executedToolCalls, options);
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
      const execCtx = this.buildToolExecCtx(executedToolCalls, options);
      const batchGen = executeToolCallsBatch(requests, execCtx);
      let outcomes: import('./tool-executor.js').ToolCallOutcome[];
      for (;;) {
        const { value, done } = await batchGen.next();
        if (done) { outcomes = value; break; }
        yield value;
      }

      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];

        // Handle browser activation: create service and swap tools.
        // Because batch-executor runs request_browser first (before parallel tools),
        // the browserState getter will return the updated state for subsequent tools.
        if (outcome.toolsModified && outcome.toolName === 'request_browser' && !this.browserActivated) {
          this.browserService = new LocalBrowserService({ headless: this.browserHeadless });
          this.browserActivated = true;
          const idx = tools.indexOf(REQUEST_BROWSER_TOOL);
          if (idx !== -1) tools.splice(idx, 1, ...BROWSER_TOOL_DEFINITIONS);
        }

        // Handle desktop activation: same pattern as browser
        if (outcome.toolsModified && outcome.toolName === 'request_desktop' && !this.desktopActivated) {
          this.desktopService = new LocalDesktopService();
          this.desktopActivated = true;
          const idx = tools.indexOf(REQUEST_DESKTOP_TOOL);
          if (idx !== -1) tools.splice(idx, 1, ...DESKTOP_TOOL_DEFINITIONS);
        }

        // Anthropic format: use formattedBlocks (with images) for browser/desktop results
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseBlocks[i].id,
          content: outcome.formattedBlocks || outcome.resultContent,
          is_error: outcome.isError,
        });
      }

      // After first tool round, always use auto (file intent forces 'any' only on first call)
      currentToolChoice = { type: 'auto' };

      // Track tool call hashes for stagnation detection
      for (const block of toolUseBlocks) {
        orchToolCallHashes.push(hashToolCall(block.name, block.input));
      }

      // Inject stagnation warning if last 3 calls are identical
      if (detectStagnation(orchToolCallHashes) && toolResults.length > 0) {
        const lastResult = toolResults[toolResults.length - 1];
        const existingContent = typeof lastResult.content === 'string' ? lastResult.content : '';
        toolResults[toolResults.length - 1] = {
          ...lastResult,
          content: `${existingContent}\n\n${STAGNATION_PROMPT}`,
        };
      }

      // Dynamic re-anchoring with progress-aware reflection
      const reflectionText = buildReflectionPrompt(userMessage, executedToolCalls, iteration, maxIter);
      const goalReminderBlock: TextBlockParam = { type: 'text', text: reflectionText };
      loopMessages.push({ role: 'user', content: [...toolResults, goalReminderBlock] });

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

    // Save to session (full turn with tool context)
    const turnMessages = buildAnthropicTurnMessages(userMessage, loopMessages, turnStartIndex, fullContent);
    await saveToSession(this.sessionDeps, sessionId, turnMessages, userMessage.slice(0, 100));

    // Extract orchestrator memory every 3rd exchange (fire-and-forget)
    this.exchangeCount++;
    if (this.exchangeCount % 3 === 0 && fullContent) {
      extractOrchestratorMemory(this.memoryDeps, sessionId, userMessage, fullContent).catch((err) => {
        logger.error(`[LocalOrchestrator] Memory extraction failed: ${err}`);
      });
    }

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
  private async runDelegateSubtask(prompt: string, focus: string, options?: ChannelChatOptions): Promise<SubOrchestratorResult> {
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
  ): Promise<Tool[]> {
    let tools = options?.excludedTools?.length
      ? ORCHESTRATOR_TOOL_DEFINITIONS.filter((t) => !options.excludedTools.includes(t.name))
      : [...ORCHESTRATOR_TOOL_DEFINITIONS];

    // Add browser tools: if pre-activated or already activated from a previous turn,
    // skip the gateway and inject full browser tools directly
    if (browserPreActivated || this.browserActivated) {
      tools = [...BROWSER_TOOL_DEFINITIONS, ...tools];
    } else {
      tools = [REQUEST_BROWSER_TOOL, ...tools];
    }

    // Add desktop tools: same two-step pattern as browser
    if (desktopPreActivated || this.desktopActivated) {
      tools = [...DESKTOP_TOOL_DEFINITIONS, ...tools];
    } else {
      tools = [REQUEST_DESKTOP_TOOL, ...tools];
    }

    const hasFileAccess = this.workingDirectory || await this.hasOrchestratorFileAccess();
    if (hasFileAccess) {
      tools = [...tools, ...FILESYSTEM_TOOL_DEFINITIONS, ...BASH_TOOL_DEFINITIONS];
    }

    // Append MCP tools (skip intent filtering — MCP tools aren't in TOOL_SECTION_MAP)
    const mcpTools = this.mcpClients?.getToolDefinitions() ?? [];

    // Filter by intent sections and priority when provided
    if (sections) {
      tools = filterToolsByIntent(tools, sections, maxPriority);
    }

    // Add MCP tools after filtering (they pass through since they're not mapped)
    if (mcpTools.length > 0) {
      tools = [...tools, ...mcpTools];
    }

    return tools;
  }

  // ==========================================================================
  // OLLAMA TOOL-CALLING LOOP
  // ==========================================================================

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
    }
    if (browserPreActivated && !this.browserActivated) {
      yield { type: 'status', message: `[debug] Browser launching (pre-activation) — headless: ${this.browserHeadless}` };
      logger.debug(`[browser] Pre-activating browser (ollama) — headless: ${this.browserHeadless}`);
      this.browserService = new LocalBrowserService({ headless: this.browserHeadless });
      this.browserActivated = true;
    }

    // Auto-activate desktop when intent is 'desktop' (skip two-step gateway for small models)
    const desktopPreActivated = classified.sections.has('desktop') && classified.intent === 'desktop';
    if (desktopPreActivated && !this.desktopActivated) {
      yield { type: 'status', message: '[debug] Desktop control launching (pre-activation)' };
      logger.debug('[desktop] Pre-activating desktop control (ollama)');
      this.desktopService = new LocalDesktopService();
      this.desktopActivated = true;
    }

    // Determine model capability tier for prompt/tool selection
    const device = detectDevice();
    const numCtx = getWorkingNumCtx(this.orchestratorModel || '', undefined, device);
    const paramTier = getParameterTier(this.orchestratorModel || '');
    const modelEntry = MODEL_CATALOG.find(m => m.tag === (this.orchestratorModel || ''));
    const modelSizeGB = modelEntry?.sizeGB ?? 2.5;
    const priorityLimit = getToolPriorityLimit(modelSizeGB, numCtx);

    // Build prompt tier-aware: micro models get bare skeleton, small get compact, medium+ get full
    const initialPromptMode: boolean | 'micro' = paramTier === 'micro' ? 'micro' : paramTier === 'small' ? true : false;
    let { staticPart: ollamaStatic, dynamicPart: ollamaDynamic } = await buildTargetedPrompt(this.promptDeps, userMessage, classified.sections, browserPreActivated || this.browserActivated, options?.platform, desktopPreActivated || this.desktopActivated, initialPromptMode);
    let systemPrompt = ollamaStatic + '\n\n' + ollamaDynamic;
    if (initialPromptMode) {
      logger.debug(`[orchestrator] Model tier: ${paramTier} (${modelSizeGB}GB) → ${initialPromptMode === 'micro' ? 'micro' : 'compact'} prompt (${estimateTokens(systemPrompt)} tokens)`);
    }

    // Convert Anthropic tool definitions to OpenAI format (with priority filtering)
    const anthropicTools = await this.getTools(options, browserPreActivated || this.browserActivated, classified.sections, desktopPreActivated || this.desktopActivated, priorityLimit);
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
        const compact = await buildTargetedPrompt(this.promptDeps, userMessage, classified.sections, browserPreActivated || this.browserActivated, options?.platform, desktopPreActivated || this.desktopActivated, true);
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
    const ollamaMaxIter = MODE_MAX_ITERATIONS[classified.mode] ?? MAX_ITERATIONS;

    // Cast provider for streaming access — safe because we only enter this
    // method when provider.name === 'ollama'
    const ollamaProvider = provider as unknown as OllamaProvider;

    for (let iteration = 0; iteration < ollamaMaxIter; iteration++) {
      let response: ModelResponseWithTools;
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
        // If tool calling fails (unsupported model), fall back to streaming text-only
        if (iteration === 0) {
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
        }
        throw err;
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
        const execCtx = this.buildToolExecCtx(executedToolCallsOllama, options);
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
            this.browserService = new LocalBrowserService({ headless: this.browserHeadless });
            this.browserActivated = true;
            const browserOpenAI = convertToolsToOpenAI(BROWSER_TOOL_DEFINITIONS);
            openaiTools = openaiTools.filter((t) => t.function.name !== 'request_browser');
            openaiTools = [...openaiTools, ...browserOpenAI];
          }

          // Handle desktop activation: same pattern as browser
          if (outcome.toolsModified && outcome.toolName === 'request_desktop' && !this.desktopActivated) {
            this.desktopService = new LocalDesktopService();
            this.desktopActivated = true;
            const desktopOpenAI = convertToolsToOpenAI(DESKTOP_TOOL_DEFINITIONS);
            openaiTools = openaiTools.filter((t) => t.function.name !== 'request_desktop');
            openaiTools = [...openaiTools, ...desktopOpenAI];
          }

          consecutiveParseErrors = 0;

          // Ollama format: use text resultContent (no image blocks)
          loopMessages.push({ role: 'tool', content: outcome.resultContent, tool_call_id: toolCall.id });
          toolResultsSummary.push({ name: req.name, content: outcome.resultContent });

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
      }

      // Track tool call hashes for stagnation detection
      for (const { req } of validRequests) {
        ollamaToolCallHashes.push(hashToolCall(req.name, req.input));
      }

      // Inject stagnation warning into the results block
      let stagnationWarning = '';
      if (detectStagnation(ollamaToolCallHashes)) {
        stagnationWarning = `\n\n${STAGNATION_PROMPT}`;
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

    // Extract orchestrator memory every 3rd exchange (fire-and-forget, parity with Claude path)
    this.exchangeCount++;
    if (this.exchangeCount % 3 === 0 && fullContent) {
      extractOrchestratorMemory(this.memoryDeps, sessionId, userMessage, fullContent).catch((err) => {
        logger.error(`[LocalOrchestrator] Memory extraction failed: ${err}`);
      });
    }

    yield {
      type: 'done',
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      traceId: ollamaTraceId,
    };
  }

}
