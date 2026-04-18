/**
 * Model router tool loop — the ~380-LOC runModelRouterLoop body lifted
 * out of RuntimeEngine.executeWithModelRouter. Runs the ReAct loop
 * against the OpenAI-format chat/completions surface (for OpenRouter /
 * Ollama providers) instead of the Anthropic SDK's native tool-use
 * shape.
 *
 * Uses the `this: RuntimeEngine` parameter pattern, matching every
 * other Phase C extraction. The function owns its own tool list,
 * iteration counter, and react trace — opts come in read-only for
 * flags and mutably for `fileAccessGuard` (doc-mount expansion).
 */

import type {
  MessageParam,
  Tool,
  WebSearchTool20250305,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { RuntimeEngine } from './engine.js';
import type { McpClientManager } from '../mcp/index.js';
import type { DesktopServiceOptions } from './desktop/index.js';
import type { ReActStep } from './task-completion.js';
import { FileAccessGuard } from './filesystem/index.js';
import { LocalBrowserService, BROWSER_TOOL_DEFINITIONS } from './browser/index.js';
import { DESKTOP_TOOL_DEFINITIONS } from './desktop/index.js';
import type { ModelProvider, ModelResponseWithTools } from './model-router.js';
import { convertToolsToOpenAI } from './tool-format.js';
import { parseToolArguments } from './tool-parse.js';
import { selectAgentModelForIteration } from './agent-model-tiers.js';
import { getToolReversibility } from '../lib/tool-reversibility.js';
import { hashToolCall, REFLECTION_PROMPT } from '../lib/stagnation.js';
import { looksLikeToolWork } from './hallucination-gate.js';
import { recordLlmCallTelemetry } from './llm-organ.js';
import { logger } from '../lib/logger.js';

// Mirror of the private LocalReActStep interface in engine.ts.
type LocalReActStep = ReActStep;

const MAX_TOOL_LOOP_ITERATIONS = 25;
const REACT_SUMMARY_MAX_LENGTH = 500;

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

export interface ModelRouterLoopOpts {
  systemPrompt: string;
  messages: MessageParam[];
  tools: Array<WebSearchTool20250305 | Tool>;
  maxTokens: number;
  temperature: number;
  taskId: string;
  agentId: string;
  workspaceId: string;
  goalId?: string;
  /** Mutable — runModelRouterLoop may reassign on doc-mount expansion. */
  fileAccessGuard: FileAccessGuard | null;
  approvalRequired: boolean;
  browserEnabled: boolean;
  mcpClients?: McpClientManager | null;
  desktopOptions?: Partial<DesktopServiceOptions>;
  difficulty?: 'simple' | 'moderate' | 'complex';
  gitEnabled?: boolean;
  /** When present, forces tool_choice: 'required' on first iteration */
  skillsDocument?: string;
  /**
   * Raw task input string used for task_shape telemetry classification.
   * Threaded from engine.ts so the loop can emit 'work' vs 'chat' into
   * llm_calls per iteration without re-reading the task row.
   */
  taskInput?: string;
}

export interface ModelRouterLoopResult {
  fullContent: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  reactTrace: ReActStep[];
  providerCostCents?: number;
  actualModelUsed?: string;
}

export async function runModelRouterLoop(
  this: RuntimeEngine,
  opts: ModelRouterLoopOpts,
): Promise<ModelRouterLoopResult> {
    // Query routing stats for adaptive model selection
    let routingHistory: import('./model-router.js').RoutingHistory | undefined;
    try {
      const { data: stats } = await this.db
        .from('agent_workforce_routing_stats')
        .select('avg_truth_score, attempts')
        .eq('agent_id', opts.agentId)
        .order('attempts', { ascending: false })
        .limit(1);
      if (stats && stats.length > 0) {
        const row = stats[0] as Record<string, unknown>;
        routingHistory = {
          avgTruthScore: (row.avg_truth_score as number) || 0,
          attempts: (row.attempts as number) || 0,
        };
      }
    } catch { /* routing stats table may not exist yet */ }

    // BPP-aware model selection: use brain confidence when available
    const provider = await this.modelRouter!.selectModelWithContext('agent_task', {
      selfModelConfidence: this.brain?.predictiveEngine?.getToolSuccessRate('agent_task'),
      routingHistory,
      difficulty: opts.difficulty,
    });

    // Agents never pin a model — the router picks dynamically per iteration
    // via `selectAgentModelForIteration`, combining difficulty, iteration
    // index, SOP presence, and vision needs.
    const needsVision = false; // TODO: detect from task/tools when vision tasks are supported
    let actualModelUsed: string | undefined;

    // Filter to client tools only (exclude Anthropic server-side tools like web_search)
    const clientTools = opts.tools.filter(
      (t): t is Tool => 'input_schema' in t,
    );
    const openaiTools = convertToolsToOpenAI(clientTools);

    // Build OpenAI-format message history
    type OllamaMessage = {
      role: 'user' | 'assistant' | 'system' | 'tool';
      content: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      tool_call_id?: string;
    };

    const loopMessages: OllamaMessage[] = opts.messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let providerCostCents = 0;
    let fullContent = '';
    const reactTrace: LocalReActStep[] = [];

    // Classify the task shape once per run so every iteration emits the
    // same task_shape value. NULL when the caller didn't pass taskInput.
    const taskShape: 'work' | 'chat' | undefined = opts.taskInput
      ? (looksLikeToolWork(opts.taskInput) ? 'work' : 'chat')
      : undefined;

    // Browser and desktop state for on-demand activation
    let browserService: LocalBrowserService | null = null;
    let browserActivated = false;
    let desktopService: import('./desktop/local-desktop.service.js').LocalDesktopService | null = null;
    let desktopActivated = false;
    let iteration = 0;
    let consecutiveParseErrors = 0;
    let toolLoopAborted = false;
    // Hard circuit breaker: when the brain flags stagnation this many times
    // in a row, abort the loop instead of just appending another warning the
    // model will ignore. Warning-only responses work for strong models;
    // weaker local models (deepseek-v3.2, qwen) observed to burn to the
    // 25-iteration cap even with repeated nudges.
    const MAX_CONSECUTIVE_STAGNATION = 3;
    let consecutiveStagnation = 0;
    const toolCallHashes: string[] = [];
    const routerToolsUsed: string[] = [];
    try {
      for (; iteration < MAX_TOOL_LOOP_ITERATIONS; iteration++) {
        const iterationStart = Date.now();
        // Build active tool list (may include browser tools after activation)
        const activeTools = browserActivated
          ? [...openaiTools.filter(t => t.function.name !== 'request_browser'), ...convertToolsToOpenAI(BROWSER_TOOL_DEFINITIONS)]
          : openaiTools;

        let response: ModelResponseWithTools;
        try {
          const providerWithTools = provider as ModelProvider & { createMessageWithTools?: typeof provider.createMessageWithTools };
          if (!providerWithTools.createMessageWithTools) {
            // Provider doesn't support tools — text-only fallback.
            // No model pin: let the provider use its configured default.
            const textResponse = await provider.createMessage({
              system: opts.systemPrompt,
              messages: loopMessages.map(m => ({
                role: m.role === 'tool' ? 'user' : m.role,
                content: m.content,
              })),
              maxTokens: opts.maxTokens,
              temperature: opts.temperature,
            });
            return {
              fullContent: textResponse.content,
              totalInputTokens: textResponse.inputTokens,
              totalOutputTokens: textResponse.outputTokens,
              reactTrace: [],
            };
          }

          // Dynamic per-iteration model selection.
          // Agents never pin — the router picks across tiers based on
          // iteration index, difficulty, error signal, SOP presence, and
          // vision requirements.
          const iterModel = selectAgentModelForIteration(
            iteration, opts.difficulty, consecutiveParseErrors > 0, !!opts.skillsDocument,
            needsVision, provider,
          );
          if (!actualModelUsed && iterModel) actualModelUsed = iterModel;
          logger.debug({ model: iterModel, iteration, provider: provider.name, difficulty: opts.difficulty }, '[engine] agent iteration model');

          // Force first tool call when SOP procedures are in the prompt
          // (iteration 0 + skillsDocument present = model MUST call a tool)
          const forceToolCall = iteration === 0 && opts.skillsDocument;
          response = await providerWithTools.createMessageWithTools({
            system: opts.systemPrompt,
            messages: loopMessages.map(m => ({
              role: m.role === 'tool' ? 'user' : m.role,
              content: m.content,
            })),
            maxTokens: opts.maxTokens,
            temperature: forceToolCall ? 0.3 : opts.temperature, // Lower temp for forced tool calls
            tools: activeTools,
            model: iterModel,
            toolChoice: forceToolCall ? 'required' : 'auto',
          } as Parameters<typeof providerWithTools.createMessageWithTools>[0]);
        } catch (err) {
          // Credit exhaustion: fall back to local Ollama and emit event
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.toLowerCase().includes('insufficient credits') || errMsg.toLowerCase().includes('credit') && errMsg.toLowerCase().includes('exhaust')) {
            if (this.modelRouter) {
              this.modelRouter.setCreditBalance(0);
            }
            this.emitter?.emit('credits:exhausted');
            logger.warn('[engine] Cloud credits exhausted, falling back to local model');
            // Try local Ollama as fallback
            const ollamaAvailable = this.modelRouter ? await this.modelRouter.isOllamaAvailable() : false;
            if (ollamaAvailable) {
              const localProvider = this.modelRouter!.getOllamaProvider()!;
              const textResponse = await localProvider.createMessage({
                system: opts.systemPrompt,
                messages: loopMessages.map(m => ({
                  role: m.role === 'tool' ? 'user' : m.role,
                  content: m.content,
                })),
                maxTokens: opts.maxTokens,
                temperature: opts.temperature,
              });
              return {
                fullContent: textResponse.content,
                totalInputTokens: textResponse.inputTokens,
                totalOutputTokens: textResponse.outputTokens,
                reactTrace: [],
              };
            }
          }
          // If tool calling fails on first iteration, fall back to text-only
          if (iteration === 0) {
            const textResponse = await provider.createMessage({
              system: opts.systemPrompt,
              messages: loopMessages.map(m => ({
                role: m.role === 'tool' ? 'user' : m.role,
                content: m.content,
              })),
              maxTokens: opts.maxTokens,
              temperature: opts.temperature,
            });
            return {
              fullContent: textResponse.content,
              totalInputTokens: textResponse.inputTokens,
              totalOutputTokens: textResponse.outputTokens,
              reactTrace: [],
            };
          }
          throw err;
        }

        totalInputTokens += response.inputTokens;
        totalOutputTokens += response.outputTokens;
        if (response.costCents) providerCostCents += response.costCents;
        this.emit('task:progress', { taskId: opts.taskId, tokensUsed: totalInputTokens + totalOutputTokens });

        if (response.content) {
          fullContent = response.content;
        }

        const iterationToolCallCount = response.toolCalls?.length ?? 0;

        // Log tool call status for debugging
        logger.debug({
          iteration,
          toolCallCount: iterationToolCallCount,
          hasContent: !!response.content,
          contentPreview: response.content?.slice(0, 100),
          model: response.model,
        }, '[engine] agent iteration response');

        // Fire-and-forget telemetry: every agent iteration lands a row
        // in llm_calls with the actual model used and whether the model
        // produced any tool_calls. This is the raw signal the agent-tier
        // selector consults to auto-demote models that can't tool-call.
        void recordLlmCallTelemetry(
          {
            db: this.db,
            workspaceId: opts.workspaceId,
            currentAgentId: opts.agentId,
            currentTaskId: opts.taskId,
            // Gap 13: direct-telemetry agent dispatch is autonomous by
            // definition. Pin the literal (matches the default) so the
            // grep-canary in origin-tagging.test.ts can audit this site.
            origin: 'autonomous',
          },
          {
            purpose: 'agent_task',
            provider: provider.name,
            model: response.model,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            costCents: response.costCents ?? 0,
            latencyMs: Date.now() - iterationStart,
            success: true,
            toolCallCount: iterationToolCallCount,
            taskShape,
          },
        );

        // No tool calls = done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          break;
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

        // Execute each tool call
        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.function.name;

          if (!toolName) {
            const errorMsg = 'Tool call missing function name. Provide a valid tool name.';
            logger.warn(`[RuntimeEngine] ${errorMsg}`);
            loopMessages.push({ role: 'tool', content: errorMsg, tool_call_id: toolCall.id });
            continue;
          }

          const parsed = parseToolArguments(toolCall.function.arguments, toolName);
          if (parsed.error) {
            logger.warn(`[RuntimeEngine] ${parsed.error}`);
            loopMessages.push({
              role: 'tool',
              content: parsed.error,
              tool_call_id: toolCall.id,
            });
            consecutiveParseErrors++;
            if (consecutiveParseErrors >= 3) {
              fullContent += '\n\n[Agent had repeated trouble calling tools and stopped.]';
              toolLoopAborted = true;
              break;
            }
            continue;
          }
          consecutiveParseErrors = 0;
          const toolInput = parsed.args;

          // Dispatch tool via registry
          const routerToolCtx = this.buildToolContext({
            taskId: opts.taskId,
            agentId: opts.agentId,
            workspaceId: opts.workspaceId,
            goalId: opts.goalId,
            browserService,
            browserActivated,
            desktopService: desktopService,
            desktopActivated,
            desktopOptions: opts.desktopOptions,
            fileAccessGuard: opts.fileAccessGuard,
            mcpClients: opts.mcpClients ?? null,
            gitEnabled: opts.gitEnabled,
          });
          const toolResult = await this.dispatchTool(toolName, toolInput, routerToolCtx);

          // Sync browser state back from context
          if (toolResult.browserActivated && !browserActivated) {
            browserService = routerToolCtx.browserService;
            browserActivated = true;
          }

          // Sync desktop state back from context (request_desktop activates desktop tools)
          if (routerToolCtx.desktopActivated && !desktopActivated) {
            desktopService = routerToolCtx.desktopService;
            desktopActivated = true;
            // Remove request_desktop from tool list and add full desktop tools
            const reqIdx = openaiTools.findIndex(t => t.function.name === 'request_desktop');
            if (reqIdx >= 0) openaiTools.splice(reqIdx, 1);
            openaiTools.push(...convertToolsToOpenAI(DESKTOP_TOOL_DEFINITIONS));
            logger.info('[engine] Desktop activated in model router path — desktop tools injected');
          }

          // Expand FileAccessGuard when doc mounts add new paths
          if (toolResult.mountedDocPaths?.length && opts.fileAccessGuard) {
            const currentPaths = opts.fileAccessGuard.getAllowedPaths();
            const expanded = [...currentPaths, ...toolResult.mountedDocPaths];
            opts.fileAccessGuard = new FileAccessGuard(expanded);
          }

          // Flatten content to string for Ollama format
          let resultContent: string;
          if (typeof toolResult.content === 'string') {
            resultContent = toolResult.is_error ? `Error: ${toolResult.content}` : toolResult.content;
          } else {
            resultContent = toolResult.content.map(b => 'text' in b ? b.text : JSON.stringify(b)).join('\n');
          }

          // Track tool name for reversibility check
          routerToolsUsed.push(toolName);

          // Brain: record tool execution
          const toolSuccess = !resultContent.startsWith('Error:');
          this.brain.recordToolExecution(toolName, toolInput, toolSuccess);
          toolCallHashes.push(hashToolCall(toolName, toolInput));

          loopMessages.push({
            role: 'tool',
            content: resultContent,
            tool_call_id: toolCall.id,
          });
        }

        // Collect ReAct step for Ollama iteration
        if (response.toolCalls && response.toolCalls.length > 0) {
          const reactStep: LocalReActStep = {
            iteration: iteration + 1,
            thought: truncate(response.content || '', REACT_SUMMARY_MAX_LENGTH),
            actions: response.toolCalls.map(tc => ({
              tool: tc.function.name,
              inputSummary: truncate(tc.function.arguments, REACT_SUMMARY_MAX_LENGTH),
            })),
            observations: response.toolCalls.map(tc => {
              const toolMsg = loopMessages.find(
                m => m.role === 'tool' && m.tool_call_id === tc.id,
              );
              return {
                tool: tc.function.name,
                resultSummary: truncate(toolMsg?.content || '', REACT_SUMMARY_MAX_LENGTH),
                success: !toolMsg?.content.startsWith('Error:'),
              };
            }),
            durationMs: Date.now() - iterationStart,
            timestamp: new Date().toISOString(),
          };
          reactTrace.push(reactStep);
          this.emit('task:react_step', { taskId: opts.taskId, step: reactStep });
        }

        if (toolLoopAborted) break;

        // Brain: enriched stagnation warning (Ollama path)
        if (this.brain.isStagnating()) {
          consecutiveStagnation++;
          const lastMsg = loopMessages[loopMessages.length - 1];
          if (lastMsg.role === 'tool') {
            lastMsg.content = `${lastMsg.content}\n\n${this.brain.buildStagnationWarning()}`;
          }
          if (consecutiveStagnation >= MAX_CONSECUTIVE_STAGNATION) {
            logger.warn(
              { taskId: opts.taskId, iteration: iteration + 1, consecutiveStagnation },
              '[RuntimeEngine] Hard stagnation circuit breaker fired — aborting tool loop',
            );
            fullContent += '\n\n[Agent looped on identical tool calls and was stopped by the stagnation circuit breaker. Synthesize an answer from what you have.]';
            toolLoopAborted = true;
            break;
          }
        } else {
          consecutiveStagnation = 0;
        }

        // Inject reflection prompt every 5 iterations
        if ((iteration + 1) % 5 === 0) {
          const lastMsg = loopMessages[loopMessages.length - 1];
          if (lastMsg.role === 'tool') {
            const reflectionText = REFLECTION_PROMPT
              .replace('{{N}}', String(iteration + 1))
              .replace('{{MAX}}', String(MAX_TOOL_LOOP_ITERATIONS));
            lastMsg.content = `${lastMsg.content}\n\n${reflectionText}`;
          }
        }
      }

      if (iteration >= MAX_TOOL_LOOP_ITERATIONS) {
        logger.warn(`[RuntimeEngine] Tool loop hit ${MAX_TOOL_LOOP_ITERATIONS} iteration limit for task ${opts.taskId}`);
        fullContent += '\n\n[Agent reached the maximum number of tool calls and stopped.]';
      }
    } finally {
      if (browserService) {
        await browserService.close().catch(err => {
          logger.error({ err }, '[RuntimeEngine] Browser cleanup failed');
        });
      }
      if (desktopService) {
        await desktopService.close().catch((err: unknown) => {
          logger.error({ err }, '[RuntimeEngine] Desktop cleanup failed');
        });
      }
    }

    // Check for irreversible tools used in Ollama path
    const irreversibleTools = routerToolsUsed.filter(
      name => getToolReversibility(name) === 'irreversible'
    );
    if (irreversibleTools.length > 0) {
      this.emit('task:warning', {
        taskId: opts.taskId,
        warning: 'irreversible_tools_used',
        tools: irreversibleTools,
      });
    }

    return { fullContent, totalInputTokens, totalOutputTokens, reactTrace, providerCostCents: providerCostCents || undefined, actualModelUsed };
}
