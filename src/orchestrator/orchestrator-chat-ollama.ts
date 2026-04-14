/**
 * Ollama chat loop — the ~625-LOC runOllamaToolLoop method lifted out of
 * LocalOrchestrator. Invoked from the dispatcher via
 * `yield* runOllamaChat.call(this, ...)` so the `this: LocalOrchestrator`
 * parameter carries the orchestrator instance and TypeScript sees the
 * body as class-scoped.
 *
 * Ollama is the simplest of the three chat loops — no SOP-aware model
 * selection (that's OpenRouter's `selectModelForIteration`), no soul /
 * narrative / ethics / immune / homeostasis wiring, no goal-checkpoint
 * extraction. It uses a narrower subset of LocalOrchestrator state than
 * runAnthropicChat or the OpenRouter loop do.
 */

import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalOrchestrator } from './local-orchestrator.js';
import type {
  ChannelChatOptions,
  OrchestratorEvent,
  ChatTurnOptions,
} from './orchestrator-types.js';
import {
  MAX_ITERATIONS,
  MODE_MAX_ITERATIONS,
  stripThinkTags,
  ThinkTagFilter,
} from './orchestrator-types.js';
import type { ModelProvider, ModelResponse, ModelResponseWithTools } from '../execution/model-router.js';
import { OllamaProvider } from '../execution/model-router.js';
import type { ToolResult } from './local-tool-types.js';
import { LocalDesktopService } from '../execution/desktop/local-desktop.service.js';
import { buildDisplayLayout } from '../execution/desktop/screenshot-capture.js';
import { DESKTOP_TOOL_DEFINITIONS } from '../execution/desktop/desktop-tools.js';
import { BROWSER_TOOL_DEFINITIONS } from '../execution/browser/browser-tools.js';
import { getToolPriorityLimit } from './tool-definitions.js';
import { ContextBudget, estimateTokens, estimateToolTokens } from './context-budget.js';
import { getWorkingNumCtx, MODEL_CATALOG, getParameterTier } from '../lib/ollama-models.js';
import { detectDevice } from '../lib/device-info.js';
import { convertToolsToOpenAI, compressToolsForContext } from '../execution/tool-format.js';
import { classifyIntent } from './intent-classifier.js';
import { buildTargetedPrompt } from './prompt-builder.js';
import { buildReflectionPrompt } from './reflection.js';
import {
  loadHistory,
  saveToSession,
  persistExchange,
  buildOllamaTurnMessages,
  extractOrchestratorMemory,
  type OllamaMessage,
} from './session-store.js';
import { reflectOnWikiOpportunities } from './wiki-reflector.js';
import {
  compactStaleOpenAIToolResults,
  checkTurnTokenBudget,
  estimateMessagesTokens,
  buildBudgetExitMessage,
} from './turn-context-guard.js';
import {
  type ToolCallRequest,
} from './tool-executor.js';
import { executeToolCallsBatch } from './batch-executor.js';
import { ConsecutiveToolBreaker } from './error-recovery.js';
import { parseToolArguments } from '../execution/tool-parse.js';
import { repairToolCall } from './tool-call-repair.js';
import { extractToolCallsFromText } from '../execution/text-tool-parse.js';
import { hashToolCall } from '../lib/stagnation.js';
import { logger } from '../lib/logger.js';
import { createTimeoutController, TimeoutError } from '../lib/with-timeout.js';
import crypto from 'crypto';

/**
 * Per-iteration model call timeout. Mirrors the same OHWOW_MODEL_CALL_TIMEOUT_MS
 * override used in local-orchestrator.ts and orchestrator-chat-anthropic.ts
 * so a hung upstream API can't lock the Ollama streaming iterator forever.
 */
const MODEL_CALL_TIMEOUT_MS = (() => {
  const fromEnv = parseInt(process.env.OHWOW_MODEL_CALL_TIMEOUT_MS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 300_000;
})();

export async function* runOllamaChat(
  this: LocalOrchestrator,
  userMessage: string,
  sessionId: string,
  provider: ModelProvider & { createMessageWithTools: NonNullable<ModelProvider['createMessageWithTools']> },
  options?: ChannelChatOptions,
  seedMessages?: MessageParam[],
  turn?: ChatTurnOptions,
): AsyncGenerator<OrchestratorEvent> {
    // Per-turn config snapshot (bug #6 fix).
    const effectiveModel = (turn?.orchestratorModel?.trim()) || this.orchestratorModel;
    const chatLog = logger.child({ chatTraceId: turn?.chatTraceId ?? sessionId.slice(0, 8) });
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
    const numCtx = getWorkingNumCtx(effectiveModel || '', undefined, device, tqBitsToolLoop);
    const paramTier = getParameterTier(effectiveModel || '');
    const modelEntry = MODEL_CATALOG.find(m => m.tag === (effectiveModel || ''));
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
        `Ollama stream (${effectiveModel || 'default'}, iter ${iteration})`,
        MODEL_CALL_TIMEOUT_MS,
      );
      try {
        // Stream tokens — createMessageWithToolsStreaming yields text tokens
        // only when no tool_calls deltas are detected, then returns the final response.
        const thinkFilter = new ThinkTagFilter();
        const streamMsgParams = {
          model: effectiveModel || undefined,
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
          chatLog.warn({ err: err.message, model: effectiveModel, iteration }, '[orchestrator] Ollama model call timed out');
          yield { type: 'text', content: `Model call timed out after ${Math.round(err.elapsedMs / 1000)}s. Try again with a smaller prompt or a faster model.` };
          throw err;
        }
        // If tool calling fails (unsupported model), fall back to streaming
        // text-only. The fallback gets its own timer below; the outer
        // ollamaStreamTimer is cleared by the outer finally.
        if (iteration === 0) {
          const fallbackTimer = createTimeoutController(
            `Ollama fallback stream (${effectiveModel || 'default'})`,
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
              chatLog.warn({ err: fallbackErr.message }, '[orchestrator] Ollama fallback stream timed out');
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
