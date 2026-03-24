/**
 * Sub-Orchestrator — lightweight, ephemeral tool loop for focused subtasks.
 * Runs its own message history and tool loop, returns only a summary to the parent.
 * Prevents context bloat in the parent orchestrator for multi-step research/data tasks.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ContentBlock,
  Tool,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from './local-tool-types.js';
import type { ModelRouter, ModelProvider, ModelResponseWithTools } from '../execution/model-router.js';
import type { CircuitBreaker } from './error-recovery.js';
import type { IntentSection } from './tool-definitions.js';
import type { ToolCallRequest, ToolExecutionContext, BrowserState } from './tool-executor.js';
import type { ToolCache } from './tool-cache.js';
import type { ChannelChatOptions } from './orchestrator-types.js';
import { ORCHESTRATOR_TOOL_DEFINITIONS, filterToolsByIntent } from './tool-definitions.js';
import { executeToolCallsBatch } from './batch-executor.js';
import { buildReflectionPrompt } from './reflection.js';
import { buildStaticInstructionsForIntent } from './system-prompt.js';
import { stripThinkTags } from './orchestrator-types.js';
import { convertToolsToOpenAI } from '../execution/tool-format.js';
import { parseToolArguments } from '../execution/tool-parse.js';
import { getWorkingNumCtx } from '../lib/ollama-models.js';
import { ContextBudget } from './context-budget.js';
import { summarizeToolResult } from './result-summarizer.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SubOrchestratorOptions {
  prompt: string;
  sections: IntentSection[];
  parentToolCtx: LocalToolContext;
  modelRouter: ModelRouter | null;
  anthropic: Anthropic;
  anthropicApiKey: string;
  orchestratorModel: string;
  circuitBreaker: CircuitBreaker;
  toolCache?: ToolCache;
  maxIterations?: number;
  options?: ChannelChatOptions;
}

export interface SubOrchestratorResult {
  summary: string;
  toolsCalled: string[];
  tokensUsed: { input: number; output: number };
  success: boolean;
}

/** Focus areas map to tool intent sections. */
const FOCUS_SECTIONS: Record<string, IntentSection[]> = {
  research: ['rag', 'business'],
  agents: ['agents'],
  crm: ['business'],
  projects: ['projects', 'agents'],
  data: ['pulse', 'business', 'agents'],
};

/** Tools excluded from sub-orchestrators (prevent recursion, nested browser, etc.) */
const EXCLUDED_TOOLS = new Set([
  'delegate_subtask',
  'request_browser',
  // All browser tools (they'd need a browser service we don't have)
  'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
  'browser_scroll', 'browser_back', 'browser_evaluate', 'browser_close',
]);

const SUB_ORCHESTRATOR_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ITERATIONS = 5;

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

function buildSubOrchestratorPrompt(sections: Set<IntentSection>): string {
  const staticInstructions = buildStaticInstructionsForIntent(sections);
  return `You are a focused research assistant. Complete the task using the tools available, then write a concise summary of your findings.

${staticInstructions}

## Constraints
- You have a limited number of iterations. Be efficient.
- Use tools to gather data, then synthesize into a clear summary.
- Do not ask follow-up questions. Work with what you have.
- Your final message should be a summary of findings, not raw tool output.`;
}

// ============================================================================
// SUB-ORCHESTRATOR
// ============================================================================

export function getFocusSections(focus: string): IntentSection[] {
  return FOCUS_SECTIONS[focus] ?? ['rag', 'business'];
}

export async function runSubOrchestrator(opts: SubOrchestratorOptions): Promise<SubOrchestratorResult> {
  const {
    prompt,
    sections,
    parentToolCtx,
    modelRouter,
    anthropic,
    orchestratorModel,
    circuitBreaker,
    toolCache,
    options,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = opts;

  const sectionSet = new Set(sections);
  const toolsCalled: string[] = [];

  // Build scoped tool list
  const tools = filterToolsByIntent([...ORCHESTRATOR_TOOL_DEFINITIONS], sectionSet)
    .filter(t => !EXCLUDED_TOOLS.has(t.name));

  const systemPrompt = buildSubOrchestratorPrompt(sectionSet);

  // Create a timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Sub-orchestrator timed out')), SUB_ORCHESTRATOR_TIMEOUT_MS);
  });

  // Build execution context (no browser, shared circuit breaker)
  const executedToolCalls = new Map<string, ToolResult>();
  const noBrowserState: BrowserState = { service: null, activated: false, headless: true, dataDir: '' };
  const execCtx: ToolExecutionContext = {
    toolCtx: parentToolCtx,
    executedToolCalls,
    browserState: noBrowserState,
    waitForPermission: async () => false, // No permissions in sub-orchestrator
    addAllowedPath: async () => {},
    options,
    circuitBreaker,
    toolCache,
  };

  try {
    // Detect model path
    if (modelRouter) {
      let provider: ModelProvider;
      try {
        provider = await modelRouter.getProvider('orchestrator');
      } catch {
        return { summary: 'No model available for sub-orchestrator.', toolsCalled, tokensUsed: { input: 0, output: 0 }, success: false };
      }

      if (provider.name === 'ollama' && provider.createMessageWithTools) {
        const result = await Promise.race([
          runOllamaSubLoop(provider as ModelProvider & { createMessageWithTools: NonNullable<ModelProvider['createMessageWithTools']> }, systemPrompt, prompt, tools, execCtx, executedToolCalls, toolsCalled, orchestratorModel, maxIterations),
          timeoutPromise,
        ]);
        return result;
      }
      // Anthropic provider — fall through
    }

    // Anthropic path — use Haiku for cost savings
    const result = await Promise.race([
      runAnthropicSubLoop(anthropic, systemPrompt, prompt, tools, execCtx, executedToolCalls, toolsCalled, maxIterations),
      timeoutPromise,
    ]);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sub-orchestrator failed';
    return {
      summary: `Sub-orchestrator error: ${msg}`,
      toolsCalled,
      tokensUsed: { input: 0, output: 0 },
      success: false,
    };
  }
}

// ============================================================================
// ANTHROPIC SUB-LOOP
// ============================================================================

async function runAnthropicSubLoop(
  anthropic: Anthropic,
  systemPrompt: string,
  userPrompt: string,
  tools: Tool[],
  execCtx: ToolExecutionContext,
  executedToolCalls: Map<string, ToolResult>,
  toolsCalled: string[],
  maxIterations: number,
): Promise<SubOrchestratorResult> {
  const messages: MessageParam[] = [{ role: 'user', content: userPrompt }];
  let totalInput = 0;
  let totalOutput = 0;
  let fullContent = '';

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: systemPrompt,
      messages,
      tools,
      tool_choice: { type: 'auto' },
      temperature: 0.3,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    // Collect text
    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        fullContent += block.text;
      }
    }

    const toolUseBlocks = response.content.filter(
      (block): block is ContentBlock & { type: 'tool_use' } => block.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0) break;

    // Append assistant message
    messages.push({ role: 'assistant', content: response.content as ContentBlockParam[] });

    // Execute tools in batch
    const requests: ToolCallRequest[] = toolUseBlocks.map(t => ({
      id: t.id,
      name: t.name,
      input: t.input as Record<string, unknown>,
    }));

    const batchGen = executeToolCallsBatch(requests, execCtx);
    let outcomes: import('./tool-executor.js').ToolCallOutcome[];
    for (;;) {
      const { value, done } = await batchGen.next();
      if (done) { outcomes = value; break; }
      // Discard events (sub-orchestrator doesn't stream to TUI)
    }

    const toolResults: ToolResultBlockParam[] = [];
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      toolsCalled.push(outcome.toolName);
      const summarized = summarizeToolResult(outcome.toolName, outcome.resultContent, outcome.isError);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUseBlocks[i].id,
        content: summarized,
        is_error: outcome.isError,
      });
    }

    // Re-anchoring
    const reflectionText = buildReflectionPrompt(userPrompt, executedToolCalls, iteration, maxIterations);
    messages.push({
      role: 'user',
      content: [...toolResults, { type: 'text' as const, text: reflectionText }],
    });
  }

  return {
    summary: fullContent || 'No results found.',
    toolsCalled: [...new Set(toolsCalled)],
    tokensUsed: { input: totalInput, output: totalOutput },
    success: true,
  };
}

// ============================================================================
// OLLAMA SUB-LOOP
// ============================================================================

interface OllamaMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

async function runOllamaSubLoop(
  provider: ModelProvider & { createMessageWithTools: NonNullable<ModelProvider['createMessageWithTools']> },
  systemPrompt: string,
  userPrompt: string,
  tools: Tool[],
  execCtx: ToolExecutionContext,
  executedToolCalls: Map<string, ToolResult>,
  toolsCalled: string[],
  orchestratorModel: string,
  maxIterations: number,
): Promise<SubOrchestratorResult> {
  const openaiTools = convertToolsToOpenAI(tools);
  const numCtx = getWorkingNumCtx(orchestratorModel || '');
  const budget = new ContextBudget(numCtx, 2048);
  budget.setSystemPrompt(systemPrompt);

  const messages: OllamaMessage[] = [{ role: 'user', content: userPrompt }];
  let totalInput = 0;
  let totalOutput = 0;
  let fullContent = '';

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let response: ModelResponseWithTools;
    try {
      response = await provider.createMessageWithTools({
        model: orchestratorModel || undefined,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        })),
        maxTokens: 2048,
        temperature: 0.3,
        tools: openaiTools,
        numCtx,
      });
    } catch {
      // Tool calling failed — break and return what we have
      break;
    }

    totalInput += response.inputTokens;
    totalOutput += response.outputTokens;

    const hasToolCalls = response.toolCalls && response.toolCalls.length > 0;
    if (response.content && !hasToolCalls) {
      const cleaned = stripThinkTags(response.content);
      if (cleaned) fullContent += cleaned;
    }

    if (!hasToolCalls) break;

    // Append assistant with tool calls
    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.toolCalls!.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: tc.function,
      })),
    });

    // Parse and execute tools
    const toolCalls = response.toolCalls!;
    const validRequests: { req: ToolCallRequest; toolCall: (typeof toolCalls)[0] }[] = [];
    for (const toolCall of toolCalls) {
      const parsed = parseToolArguments(toolCall.function.arguments, toolCall.function.name);
      if (parsed.error) {
        messages.push({ role: 'tool', content: parsed.error, tool_call_id: toolCall.id });
        continue;
      }
      validRequests.push({
        req: { id: toolCall.id, name: toolCall.function.name, input: parsed.args },
        toolCall,
      });
    }

    if (validRequests.length > 0) {
      const batchGen = executeToolCallsBatch(validRequests.map(v => v.req), execCtx);
      let outcomes: import('./tool-executor.js').ToolCallOutcome[];
      for (;;) {
        const { value, done } = await batchGen.next();
        if (done) { outcomes = value; break; }
      }

      const resultsSummary: string[] = [];
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        const { toolCall } = validRequests[i];
        toolsCalled.push(outcome.toolName);
        const summarized = summarizeToolResult(outcome.toolName, outcome.resultContent, outcome.isError);
        messages.push({ role: 'tool', content: summarized, tool_call_id: toolCall.id });
        resultsSummary.push(`## ${outcome.toolName}\n${summarized}`);
      }

      // Re-anchoring
      const reflection = buildReflectionPrompt(userPrompt, executedToolCalls, iteration, maxIterations);
      messages.push({
        role: 'user',
        content: `[Tool Results:\n${resultsSummary.join('\n\n')}\n\n${reflection}]`,
      });
    }
  }

  return {
    summary: fullContent || 'No results found.',
    toolsCalled: [...new Set(toolsCalled)],
    tokensUsed: { input: totalInput, output: totalOutput },
    success: true,
  };
}
