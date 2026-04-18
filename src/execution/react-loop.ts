/**
 * Anthropic ReAct tool loop — the hot-path body that used to live inside
 * RuntimeEngine.executeTask's `} else if (tools.length > 0) {` branch.
 *
 * Extracted in C7b. The function mutates `args.services` and
 * `args.caps.fileAccessGuard` in place so the outer `finally` in
 * executeTask can still close the browser/desktop/MCP clients that got
 * activated mid-loop and so the doc-mount expansion flows back into the
 * capability record.
 *
 * The `paused` field on the return value signals that executeTask should
 * skip the completion pipeline and return a paused ExecuteAgentResult
 * directly. The outer finally still runs for cleanup either way.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  Tool,
  TextBlock,
  ToolUseBlock,
  ToolResultBlockParam,
  WebSearchTool20250305,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { RuntimeEngine } from './engine.js';
import type { TaskCapabilities } from './task-capabilities.js';
import type { LocalBrowserService } from './browser/index.js';
import {
  BROWSER_TOOL_DEFINITIONS,
  LocalBrowserService as LocalBrowserServiceClass,
} from './browser/index.js';
import type { LocalDesktopService } from './desktop/index.js';
import {
  DESKTOP_TOOL_DEFINITIONS,
  LocalDesktopService as LocalDesktopServiceClass,
} from './desktop/index.js';
import { FileAccessGuard, FILESYSTEM_TOOL_DEFINITIONS } from './filesystem/index.js';
import { looksLikeToolWork } from './hallucination-gate.js';
import { recordLlmCallTelemetry } from './llm-organ.js';
import type { McpClientManager } from '../mcp/index.js';
import type { ReActStep } from './task-completion.js';
import type { ClaudeModel } from './ai-types.js';
import { calculateCostCents } from './ai-types.js';
import type { LocalLLMCache } from './llm-cache.js';
import type { AutonomyBudget } from './budget-guard.js';
import { checkMidLoop } from './budget-guard.js';
import {
  summarizeMessages,
  CONTEXT_WARNING_THRESHOLD_PCT,
  CONTEXT_SUMMARIZE_THRESHOLD_PCT,
  SUMMARIZE_COOLDOWN_ITERATIONS,
} from './message-summarization.js';
import { LocalActionJournalService } from '../lib/action-journal.js';
import { getToolReversibility } from '../lib/tool-reversibility.js';
import { hashToolCall, REFLECTION_PROMPT } from '../lib/stagnation.js';
import { serializeCheckpoint, type TaskCheckpoint } from './checkpoint-types.js';
import { logger } from '../lib/logger.js';

const MAX_TOOL_LOOP_ITERATIONS = 25;
const REACT_SUMMARY_MAX_LENGTH = 500;

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

export interface ReActServicesHolder {
  browserService: LocalBrowserService | null;
  browserActivated: boolean;
  desktopService: LocalDesktopService | null;
  desktopActivated: boolean;
}

export interface ReActLoopArgs {
  systemPrompt: string;
  systemPromptHash: string;
  messages: MessageParam[];
  tools: Array<WebSearchTool20250305 | Tool>;
  caps: TaskCapabilities;
  services: ReActServicesHolder;
  mcpClients: McpClientManager | null;
  taskId: string;
  agentId: string;
  workspaceId: string;
  task: {
    title: string;
    input: string | unknown;
    goal_id: string | null;
  };
  agentConfig: Record<string, unknown>;
  agent: { name: string };
  modelId: string;
  contextLimit: number;
  llmCache: LocalLLMCache;
  agentBudget: AutonomyBudget | null;
  startTime: number;
}

export interface ReActLoopPausedResult {
  output: { text: string };
  tokensUsed: number;
  costCents: number;
}

export interface ReActLoopResult {
  fullContent: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  reactTrace: ReActStep[];
  anthropicToolsUsed: string[];
  /**
   * When set, the ReAct loop returned early because the agent paused
   * (a mid-loop checkpoint signalled a user intervention). The caller
   * should skip the completion pipeline and return this result to the
   * task executor directly.
   */
  paused?: ReActLoopPausedResult;
}

export async function runAnthropicReActLoop(
  this: RuntimeEngine,
  args: ReActLoopArgs,
): Promise<ReActLoopResult> {
  const {
    systemPrompt,
    systemPromptHash,
    messages,
    tools,
    caps,
    services,
    mcpClients,
    taskId,
    agentId,
    workspaceId,
    task,
    agentConfig,
    agent,
    modelId,
    contextLimit,
    llmCache,
    agentBudget,
    startTime,
  } = args;

  let currentMessages = [...messages];
  let iterations = 0;
  const toolCallHashes: string[] = [];
  const anthropicToolsUsed: string[] = [];
  let iterationsSinceSummarize = SUMMARIZE_COOLDOWN_ITERATIONS; // allow summarization from start
  let fullContent = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const reactTrace: ReActStep[] = [];

  // Classify the task shape once per run so every iteration emits the
  // same task_shape value into llm_calls telemetry.
  const taskInputStr = typeof task.input === 'string' ? task.input : JSON.stringify(task.input ?? '');
  const taskShape: 'work' | 'chat' = looksLikeToolWork(taskInputStr) ? 'work' : 'chat';

  while (iterations < MAX_TOOL_LOOP_ITERATIONS) {
    iterations++;
    const iterationStart = Date.now();

    // Check LLM cache for first iteration (no tool results in messages)
    const isToolContinuation = iterations > 1;
    let response: Anthropic.Messages.Message;

    if (!isToolContinuation) {
      const cached = await llmCache.lookup(systemPromptHash, currentMessages, modelId);
      if (cached) {
        logger.debug({ modelId, similarity: cached.similarity }, 'Local LLM cache hit');
        response = {
          id: `msg_cached_${Date.now()}`,
          type: 'message',
          container: null,
          role: 'assistant',
          content: [{ type: 'text' as const, text: cached.responseContent, citations: null }],
          model: modelId as Anthropic.Messages.Model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: cached.responseTokens.input_tokens,
            output_tokens: cached.responseTokens.output_tokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: null,
            inference_geo: null,
            server_tool_use: null,
            service_tier: null,
          },
        };
      } else {
        response = await this.anthropic!.messages.create({
          model: modelId,
          max_tokens: (agentConfig.max_tokens as number) || 4096,
          temperature: (agentConfig.temperature as number) ?? 0.7,
          system: systemPrompt,
          messages: currentMessages,
          tools,
        });
      }
    } else {
      response = await this.anthropic!.messages.create({
        model: modelId,
        max_tokens: (agentConfig.max_tokens as number) || 4096,
        temperature: (agentConfig.temperature as number) ?? 0.7,
        system: systemPrompt,
        messages: currentMessages,
        tools,
      });
    }

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    this.emit('task:progress', { taskId, tokensUsed: totalInputTokens + totalOutputTokens });

    const textBlocks = response.content.filter((b): b is TextBlock => b.type === 'text');
    const textContent = textBlocks.map((b) => b.text).join('\n');

    // Fire-and-forget telemetry: every agent iteration lands a row in
    // llm_calls with the actual model, input/output tokens, and whether
    // the model emitted any tool_use blocks. Skip cached responses so
    // the rolling tool-call rate reflects real provider behavior, not
    // cache hits. The agent-tier selector consults these rows to
    // auto-demote models that stop tool-calling reliably.
    const iterationToolCallCount = response.content.filter(
      (b) => b.type === 'tool_use',
    ).length;
    const isCachedResponse = response.id.startsWith('msg_cached_');
    if (!isCachedResponse) {
      void recordLlmCallTelemetry(
        {
          db: this.db,
          workspaceId,
          currentAgentId: agentId,
          currentTaskId: taskId,
          // Gap 13: direct-telemetry agent dispatch is autonomous by
          // definition. Pin the literal (matches the default) so the
          // grep-canary in origin-tagging.test.ts can audit this site.
          origin: 'autonomous',
        },
        {
          purpose: 'agent_task',
          provider: 'anthropic',
          model: modelId,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          costCents: 0, // calculated downstream; keep consistent with existing llm_calls rows
          latencyMs: Date.now() - iterationStart,
          success: true,
          toolCallCount: iterationToolCallCount,
          taskShape,
        },
      );
    }

    // Budget guard: mid-loop per-task cost check
    if (agentBudget) {
      const runningCost = calculateCostCents(
        modelId as ClaudeModel,
        totalInputTokens,
        totalOutputTokens,
      );
      const midCheck = checkMidLoop(runningCost, agentBudget);
      if (!midCheck.allowed) {
        logger.warn({ agentId, taskId, runningCost, reason: midCheck.reason }, '[RuntimeEngine] Mid-loop budget hard stop');
        await this.db.rpc('create_agent_activity', {
          p_workspace_id: workspaceId,
          p_activity_type: 'budget_hard_stop',
          p_title: `Per-task budget hit for ${agent.name}`,
          p_description: midCheck.reason,
          p_agent_id: agentId,
          p_task_id: taskId,
          p_metadata: { runtime: true, runningCost },
        });
        this.emit('budget:exceeded', { agentId, taskId, reason: midCheck.reason });
        fullContent = textContent || fullContent;
        break;
      }
    }

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      // Cache end_turn responses for future reuse
      if (!isToolContinuation && response.stop_reason === 'end_turn' && textContent) {
        void llmCache.store(systemPromptHash, currentMessages, modelId, textContent, {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        });
      }
      fullContent = textContent;
      break;
    }

    // Handle server tool uses (web search) — SDK handles these automatically
    const hasServerTool = response.content.some((b) => b.type === 'server_tool_use');

    // Handle client tool uses — unified dispatch for all tool types
    const toolUseBlocks = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

    if (toolUseBlocks.length === 0 && hasServerTool) {
      // Web search only — let the SDK continue
      currentMessages = [...currentMessages, { role: 'assistant' as const, content: response.content }];
      continue;
    }

    if (toolUseBlocks.length === 0) {
      fullContent = textContent;
      break;
    }

    // Activate browser on-demand if request_browser is called
    const hasRequestBrowser = toolUseBlocks.some((b) => b.name === 'request_browser');
    if (hasRequestBrowser && !services.browserActivated) {
      // Connect to real Chrome via CDP when browserTarget is 'chrome'
      if (this.config.browserTarget === 'chrome') {
        try {
          const cdpUrl = await LocalBrowserServiceClass.connectToChrome(this.config.chromeCdpPort || 9222);
          services.browserService = new LocalBrowserServiceClass({ headless: false, cdpUrl: cdpUrl || undefined });
        } catch {
          services.browserService = new LocalBrowserServiceClass({ headless: this.config.browserHeadless });
        }
      } else {
        services.browserService = new LocalBrowserServiceClass({ headless: this.config.browserHeadless });
      }
      services.browserActivated = true;

      // Remove request_browser from tools and add full browser toolkit
      const requestBrowserIdx = tools.findIndex((t) => 'name' in t && t.name === 'request_browser');
      if (requestBrowserIdx !== -1) tools.splice(requestBrowserIdx, 1);
      tools.push(...BROWSER_TOOL_DEFINITIONS);
    }

    // Activate desktop on-demand if request_desktop is called
    const hasRequestDesktop = toolUseBlocks.some((b) => b.name === 'request_desktop');
    if (hasRequestDesktop && !services.desktopActivated) {
      services.desktopService = new LocalDesktopServiceClass({ dataDir: this.config.dataDir, ...caps.desktopOptions });
      services.desktopActivated = true;

      const requestDesktopIdx = tools.findIndex((t) => 'name' in t && t.name === 'request_desktop');
      if (requestDesktopIdx !== -1) tools.splice(requestDesktopIdx, 1);
      tools.push(...DESKTOP_TOOL_DEFINITIONS);
    }

    // Unified tool result collection via registry
    const toolResults: ToolResultBlockParam[] = [];
    const toolCtx = this.buildToolContext({
      taskId,
      agentId,
      workspaceId,
      goalId: task.goal_id || undefined,
      browserService: services.browserService,
      browserActivated: services.browserActivated,
      desktopService: services.desktopService,
      desktopActivated: services.desktopActivated,
      desktopOptions: caps.desktopOptions,
      fileAccessGuard: caps.fileAccessGuard,
      mcpClients,
      gitEnabled: caps.bashEnabled,
    });

    for (const block of toolUseBlocks) {
      const result = await this.dispatchTool(
        block.name,
        block.input as Record<string, unknown>,
        toolCtx,
      );

      // Sync browser state back from context (request_browser mutates it)
      if (result.browserActivated && !services.browserActivated) {
        services.browserService = toolCtx.browserService;
        services.browserActivated = true;
        const requestBrowserIdx = tools.findIndex((t) => 'name' in t && t.name === 'request_browser');
        if (requestBrowserIdx !== -1) tools.splice(requestBrowserIdx, 1);
        tools.push(...BROWSER_TOOL_DEFINITIONS);
      }

      // Sync desktop state back from context (request_desktop mutates it)
      if (result.desktopActivated && !services.desktopActivated) {
        services.desktopService = toolCtx.desktopService;
        services.desktopActivated = true;
        const requestDesktopIdx = tools.findIndex((t) => 'name' in t && t.name === 'request_desktop');
        if (requestDesktopIdx !== -1) tools.splice(requestDesktopIdx, 1);
        tools.push(...DESKTOP_TOOL_DEFINITIONS);
      }

      // Expand FileAccessGuard when doc mounts add new paths.
      // Mutates caps.fileAccessGuard in place so the next
      // buildToolContext call in this loop sees the expanded guard
      // and so executeTask's outer scope observes the final value.
      if (result.mountedDocPaths?.length) {
        const currentPaths = caps.fileAccessGuard?.getAllowedPaths() ?? [];
        const expanded = [...currentPaths, ...result.mountedDocPaths];
        caps.fileAccessGuard = new FileAccessGuard(expanded);
        // Ensure filesystem tools are available if not already
        if (!tools.some((t) => 'name' in t && t.name === 'local_list_directory')) {
          tools.push(...FILESYSTEM_TOOL_DEFINITIONS);
        }
      }

      // Cast content to the SDK-expected type (our ToolCallResult is wider)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content as string,
        is_error: result.is_error,
      });
    }

    if (toolResults.length > 0) {
      // Track tool names for reversibility check
      for (const block of toolUseBlocks) {
        anthropicToolsUsed.push(block.name);
      }

      // Brain: record tool executions (perceive → predict → record)
      for (const block of toolUseBlocks) {
        const matchedResult = toolResults.find((r) => r.tool_use_id === block.id);
        if (matchedResult) {
          this.brain.recordToolExecution(block.name, block.input, !matchedResult.is_error);
        }
        toolCallHashes.push(hashToolCall(block.name, block.input));
      }

      // Brain: enriched stagnation warning
      if (this.brain.isStagnating() && toolResults.length > 0) {
        const lastResult = toolResults[toolResults.length - 1];
        const existingContent = typeof lastResult.content === 'string' ? lastResult.content : '';
        const warning = this.brain.buildStagnationWarning();
        toolResults[toolResults.length - 1] = {
          ...lastResult,
          content: `${existingContent}\n\n${warning}`,
        };
      }

      // Inject reflection prompt every 5 iterations
      if (iterations % 5 === 0 && toolResults.length > 0) {
        const lastResult = toolResults[toolResults.length - 1];
        const existingContent = typeof lastResult.content === 'string' ? lastResult.content : '';
        const reflectionText = REFLECTION_PROMPT
          .replace('{{N}}', String(iterations))
          .replace('{{MAX}}', String(MAX_TOOL_LOOP_ITERATIONS));
        toolResults[toolResults.length - 1] = {
          ...lastResult,
          content: `${existingContent}\n\n${reflectionText}`,
        };
      }

      // Log side-effecting tool calls to action journal
      for (const block of toolUseBlocks) {
        const toolRev = getToolReversibility(block.name);
        if (toolRev !== 'read_only') {
          const matchingResult = toolResults.find((r) => r.tool_use_id === block.id);
          const journal = new LocalActionJournalService(this.db, workspaceId);
          journal.logAction({
            taskId,
            agentId,
            toolName: block.name,
            toolInput: block.input as Record<string, unknown>,
            toolOutput: matchingResult ? (typeof matchingResult.content === 'string' ? matchingResult.content : JSON.stringify(matchingResult.content)) : null,
            reversibility: toolRev,
          }).catch(() => { /* non-fatal */ });
        }
      }

      // Collect ReAct step
      const reactStep: ReActStep = {
        iteration: iterations,
        thought: textContent.trim() ? truncate(textContent, REACT_SUMMARY_MAX_LENGTH) : '',
        actions: toolUseBlocks.map((b) => ({
          tool: b.name,
          inputSummary: truncate(JSON.stringify(b.input), REACT_SUMMARY_MAX_LENGTH),
        })),
        observations: toolResults.map((r) => ({
          tool: toolUseBlocks.find((b) => b.id === r.tool_use_id)?.name || 'unknown',
          resultSummary: truncate(
            typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
            REACT_SUMMARY_MAX_LENGTH,
          ),
          success: !r.is_error,
        })),
        durationMs: Date.now() - iterationStart,
        timestamp: new Date().toISOString(),
      };
      reactTrace.push(reactStep);
      this.emit('task:react_step', { taskId, step: reactStep });

      currentMessages = [
        ...currentMessages,
        { role: 'assistant' as const, content: response.content },
        { role: 'user' as const, content: toolResults },
      ];

      // Mid-loop context summarization: check if we're approaching limits
      iterationsSinceSummarize++;
      const utilizationPct = totalInputTokens / contextLimit;
      if (utilizationPct >= CONTEXT_WARNING_THRESHOLD_PCT) {
        logger.warn(`[RuntimeEngine] Context utilization at ${Math.round(utilizationPct * 100)}% for task ${taskId}`);
      }
      if (
        utilizationPct >= CONTEXT_SUMMARIZE_THRESHOLD_PCT &&
        iterationsSinceSummarize >= SUMMARIZE_COOLDOWN_ITERATIONS &&
        currentMessages.length > 6
      ) {
        currentMessages = await summarizeMessages(currentMessages, this.anthropic);
        iterationsSinceSummarize = 0;
      }

      // Save checkpoint after each iteration (fire-and-forget)
      const iterCheckpoint: TaskCheckpoint = {
        version: 1,
        messages: currentMessages,
        iteration: iterations,
        toolCallCount: toolCallHashes.length,
        totalInputTokens,
        totalOutputTokens,
        toolCallHashes,
        elapsedMs: Date.now() - startTime,
        savedAt: new Date().toISOString(),
        reason: 'iteration_save',
      };
      void this.db.from('agent_workforce_tasks').update({
        checkpoint: serializeCheckpoint(iterCheckpoint),
        checkpoint_iteration: iterations,
      }).eq('id', taskId).then(() => {});

      // Check for pause request
      try {
        const { data: pauseCheck } = await this.db
          .from('agent_workforce_tasks')
          .select('pause_requested')
          .eq('id', taskId)
          .single();
        if (pauseCheck && (pauseCheck as { pause_requested?: number }).pause_requested) {
          const pauseCheckpoint: TaskCheckpoint = { ...iterCheckpoint, reason: 'pause_requested' };
          await this.db.from('agent_workforce_tasks').update({
            checkpoint: serializeCheckpoint(pauseCheckpoint),
            checkpoint_iteration: iterations,
            status: 'paused',
          }).eq('id', taskId);
          logger.info({ taskId, iteration: iterations }, 'Task paused at checkpoint');
          return {
            fullContent,
            totalInputTokens,
            totalOutputTokens,
            reactTrace,
            anthropicToolsUsed,
            paused: {
              output: { text: fullContent || textContent },
              tokensUsed: totalInputTokens + totalOutputTokens,
              costCents: calculateCostCents(modelId as ClaudeModel, totalInputTokens, totalOutputTokens),
            },
          };
        }
      } catch { /* non-fatal pause check */ }

      continue;
    }

    fullContent = textContent;
    break;
  }

  return {
    fullContent,
    totalInputTokens,
    totalOutputTokens,
    reactTrace,
    anthropicToolsUsed,
  };
}
