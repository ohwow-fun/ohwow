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
import { detectDevice } from '../lib/device-info.js';
import { ContextBudget } from './context-budget.js';
import { summarizeToolResult } from './result-summarizer.js';
import type { FoldResult } from '../execution/fold-types.js';
import { emptyFold } from '../execution/fold-types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SubOrchestratorOptions {
  prompt: string;
  sections: IntentSection[];
  /** Recursive fold depth (0 = first level, max 3). Controls nested delegate_subtask. */
  depth?: number;
  parentToolCtx: LocalToolContext;
  modelRouter: ModelRouter | null;
  anthropic: Anthropic;
  anthropicApiKey: string;
  orchestratorModel: string;
  circuitBreaker: CircuitBreaker;
  toolCache?: ToolCache;
  maxIterations?: number;
  /** Hard wall-clock timeout for the entire sub-orchestrator run. Defaults to 60s. */
  timeoutMs?: number;
  options?: ChannelChatOptions;
}

export interface SubOrchestratorResult {
  summary: string;
  /** Structured fold of the exploration (when available, prefer over raw summary) */
  fold: FoldResult;
  toolsCalled: string[];
  tokensUsed: { input: number; output: number };
  success: boolean;
}

// ============================================================================
// FOLD EXTRACTION
// ============================================================================

/**
 * Extract a structured FoldResult from the model's raw text output.
 * Looks for structured patterns (bullet points, headings) and extracts
 * into the typed fold format. Falls back to treating the full text as
 * the conclusion if no structure is found.
 */
function extractFoldResult(rawText: string, toolsCalled: string[]): FoldResult {
  const fold = emptyFold();
  if (!rawText || rawText.trim().length === 0) return fold;

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  // Try to identify structured sections
  const deadEnds: Array<{ approach: string; failure_reason: string; learning: string }> = [];
  const evidence: string[] = [];
  const decisions: string[] = [];
  let conclusion = '';

  let currentSection = 'general';

  for (const line of lines) {
    const lower = line.toLowerCase();

    // Detect section headers
    if (lower.includes('conclusion') || lower.includes('summary') || lower.includes('result')) {
      currentSection = 'conclusion';
      continue;
    }
    if (lower.includes('evidence') || lower.includes('finding') || lower.includes('found')) {
      currentSection = 'evidence';
      continue;
    }
    if (lower.includes('decision') || lower.includes('chose') || lower.includes('selected')) {
      currentSection = 'decisions';
      continue;
    }
    if (lower.includes('dead end') || lower.includes('failed') || lower.includes('didn\'t work')) {
      currentSection = 'dead_ends';
      continue;
    }

    // Strip bullet markers
    const cleaned = line.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '');

    switch (currentSection) {
      case 'conclusion':
        conclusion += (conclusion ? ' ' : '') + cleaned;
        break;
      case 'evidence':
        if (cleaned.length > 10) evidence.push(cleaned);
        break;
      case 'decisions':
        if (cleaned.length > 10) decisions.push(cleaned);
        break;
      case 'dead_ends':
        if (cleaned.length > 10) {
          deadEnds.push({ approach: cleaned, failure_reason: 'See context', learning: cleaned });
        }
        break;
      default:
        // General text goes to conclusion
        conclusion += (conclusion ? ' ' : '') + cleaned;
    }
  }

  // If no structured conclusion was found, use the full text
  if (!conclusion) conclusion = rawText.slice(0, 500);

  fold.conclusion = conclusion;
  fold.evidence = evidence.slice(0, 10);
  fold.decisions_made = decisions.slice(0, 5);
  fold.dead_ends = deadEnds.slice(0, 5);
  fold.artifacts_created = toolsCalled.filter(t =>
    ['create_file', 'write_file', 'run_agent', 'queue_task', 'set_state'].includes(t),
  );

  return fold;
}

/** Focus areas map to tool intent sections. */
const FOCUS_SECTIONS: Record<string, IntentSection[]> = {
  research: ['rag', 'business'],
  agents: ['agents'],
  crm: ['business'],
  projects: ['projects', 'agents'],
  data: ['pulse', 'business', 'agents'],
  // Wiki focus: only the markdown synthesis layer. Used by wiki_curate
  // and any future janitorial wiki work that should run in isolation
  // from the parent chat's context.
  wiki: ['rag'],
};

/**
 * Per-focus wall-clock timeouts. Janitorial focuses that walk a
 * backlog (e.g., wiki lint-fix loops across 14+ pages) legitimately
 * need several minutes on cloud-tier Haiku. Research-shaped focuses
 * should fail fast because a stuck RAG loop is usually a model
 * confusion loop, not real work.
 */
const FOCUS_TIMEOUTS_MS: Record<string, number> = {
  wiki: 420_000,     // 7 min — 18 iters × ~20s worst case
  research: 180_000, // 3 min
  agents: 180_000,
  crm: 180_000,
  projects: 240_000,
  data: 240_000,
};

export function getTimeoutForFocus(focus: string): number {
  return FOCUS_TIMEOUTS_MS[focus] ?? DEFAULT_SUB_ORCHESTRATOR_TIMEOUT_MS;
}

/** Max recursive fold depth for nested sub-orchestrators */
const MAX_FOLD_DEPTH = 3;

/** Browser tools excluded from sub-orchestrators (they'd need a browser service) */
const EXCLUDED_BROWSER_TOOLS = new Set([
  'request_browser',
  'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
  'browser_scroll', 'browser_back', 'browser_evaluate', 'browser_close',
]);

/**
 * Get excluded tools based on fold depth.
 * At depths below MAX_FOLD_DEPTH, delegate_subtask is allowed (enabling recursive folding).
 * At MAX_FOLD_DEPTH, delegate_subtask is excluded to prevent infinite recursion.
 */
function getExcludedTools(depth: number): Set<string> {
  const excluded = new Set(EXCLUDED_BROWSER_TOOLS);
  if (depth >= MAX_FOLD_DEPTH) {
    excluded.add('delegate_subtask');
  }
  return excluded;
}

/**
 * Default wall-clock timeout for a sub-orchestrator run. Individual
 * callers override via SubOrchestratorOptions.timeoutMs when the work
 * is known to be longer (e.g., wiki janitorial passes walking a backlog
 * of lint findings). 180s is long enough for 5 default iterations even
 * on a slow cloud provider, short enough that a stuck loop fails fast.
 */
const DEFAULT_SUB_ORCHESTRATOR_TIMEOUT_MS = 180_000;
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
    timeoutMs = DEFAULT_SUB_ORCHESTRATOR_TIMEOUT_MS,
    depth = 0,
  } = opts;

  const sectionSet = new Set(sections);
  const toolsCalled: string[] = [];

  // Build scoped tool list (depth-aware: allow delegate_subtask below MAX_FOLD_DEPTH)
  const excludedTools = getExcludedTools(depth);
  const tools = filterToolsByIntent([...ORCHESTRATOR_TOOL_DEFINITIONS], sectionSet)
    .filter(t => !excludedTools.has(t.name));

  const systemPrompt = buildSubOrchestratorPrompt(sectionSet);

  // Create a timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Sub-orchestrator timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
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
    // Recursive delegate_subtask: spawns a nested sub-orchestrator at depth+1
    delegateSubtask: depth < MAX_FOLD_DEPTH
      ? async (subPrompt: string, focus: string) => runSubOrchestrator({
          prompt: subPrompt,
          sections: getFocusSections(focus),
          parentToolCtx,
          modelRouter,
          anthropic,
          anthropicApiKey: opts.anthropicApiKey,
          orchestratorModel,
          circuitBreaker,
          toolCache,
          options,
          depth: depth + 1,
          timeoutMs: getTimeoutForFocus(focus),
        })
      : undefined,
  };

  try {
    // Detect model path
    if (modelRouter) {
      let provider: ModelProvider;
      try {
        provider = await modelRouter.getProvider('orchestrator');
      } catch {
        return { summary: 'No model available for sub-orchestrator.', fold: emptyFold(), toolsCalled, tokensUsed: { input: 0, output: 0 }, success: false };
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
      fold: emptyFold(),
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

  const uniqueTools = [...new Set(toolsCalled)];
  return {
    summary: fullContent || 'No results found.',
    fold: extractFoldResult(fullContent, uniqueTools),
    toolsCalled: uniqueTools,
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
  const numCtx = getWorkingNumCtx(orchestratorModel || '', undefined, detectDevice());
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

  const uniqueToolsOllama = [...new Set(toolsCalled)];
  return {
    summary: fullContent || 'No results found.',
    fold: extractFoldResult(fullContent, uniqueToolsOllama),
    toolsCalled: uniqueToolsOllama,
    tokensUsed: { input: totalInput, output: totalOutput },
    success: true,
  };
}
