/**
 * OpenRouter chat loop — the ~780-LOC runOpenRouterToolLoop method lifted
 * out of LocalOrchestrator. Invoked from the dispatcher via
 * `yield* runOpenRouterChat.call(this, ...)` so the `this: LocalOrchestrator`
 * parameter carries the orchestrator instance.
 *
 * Unlike the Ollama path, OpenRouter gets the full Anthropic-style
 * capability surface (brain perception, philosophical layers, tool
 * embodiment, deliberation, mid-loop summarization) — only the wire
 * format differs (OpenAI chat/completions + streaming instead of the
 * Anthropic SDK).
 *
 * `selectModelForIteration` lives in this file too: its only call site
 * is the OpenRouter loop, and it reads `orchestratorModel` from the
 * orchestrator instance. Converted from a class method to a free
 * function taking the configured model string explicitly.
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
import { loadConversationPersona } from './conversation-persona.js';
import type { GoalCheckpointDeps } from './goal-checkpoints.js';
import type { OpenRouterProvider, ModelResponseWithTools } from '../execution/model-router.js';
import type { ToolResult } from './local-tool-types.js';
import { LocalDesktopService } from '../execution/desktop/local-desktop.service.js';
import { buildDisplayLayout } from '../execution/desktop/screenshot-capture.js';
import { DESKTOP_TOOL_DEFINITIONS } from '../execution/desktop/desktop-tools.js';
import { BROWSER_TOOL_DEFINITIONS } from '../execution/browser/browser-tools.js';
import {
  FILESYSTEM_TOOL_DEFINITIONS,
  BASH_TOOL_DEFINITIONS,
} from './tool-definitions.js';
import { invalidateFileAccessCache } from './tools/filesystem.js';
import { invalidateBashAccessCache } from './tools/bash.js';
import { ContextBudget, estimateTokens, estimateToolTokens } from './context-budget.js';
import { convertToolsToOpenAI } from '../execution/tool-format.js';
import { classifyIntent } from './intent-classifier.js';
import { enrichIntent } from '../brain/intentionality.js';
import type { Stimulus, Perception, WorkspaceItem } from '../brain/types.js';
import type { SelfModelDeps } from '../brain/self-model.js';
import { BodyStateService } from '../body/body-state.js';
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
import { extractGoalCheckpoints, loadActiveGoals, formatGoalsForPrompt } from './goal-checkpoints.js';
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
import { recordLlmCallTelemetry } from '../execution/llm-organ.js';
import { repairToolCall } from './tool-call-repair.js';
import { hashToolCall } from '../lib/stagnation.js';
import { logger } from '../lib/logger.js';
import { createTimeoutController, TimeoutError } from '../lib/with-timeout.js';
import crypto from 'crypto';

/**
 * Per-iteration model call timeout. Mirrors the env-overridable constant
 * shared across all three chat loops; a hung upstream call can't lock the
 * streaming iterator forever.
 */
const MODEL_CALL_TIMEOUT_MS = (() => {
  const fromEnv = parseInt(process.env.OHWOW_MODEL_CALL_TIMEOUT_MS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 300_000;
})();

/**
 * Select the best model for a given OpenRouter tool-loop iteration.
 * Iteration 0: Grok 4.20 (2M context, strong reasoning — the orchestrator brain).
 * Follow-ups: Grok 4.1 Fast (cheap tool routing and summaries).
 * Escalates back to 4.20 for errors, heavy tool results, or long recent
 * tool outputs. If the user explicitly configured a non-grok model, that
 * choice is respected unconditionally.
 */
function selectModelForIteration(
  configured: string,
  iteration: number,
  messages: OllamaMessage[],
  previousToolCallCount: number,
  hasErrors: boolean,
): string {
  const CHEAP = 'x-ai/grok-4.1-fast';
  const STRONG = 'x-ai/grok-4.20';

  // If user explicitly configured a non-grok model, respect it.
  if (configured && !configured.startsWith('x-ai/grok-')) {
    return configured;
  }

  // Iteration 0: always use the strong model (2M context brain). The
  // orchestrator needs deep context for initial reasoning, tool planning,
  // and sub-orchestrator coordination.
  if (iteration === 0) return STRONG;

  // Escalate on errors or retries.
  if (hasErrors) return STRONG;

  // Heavy tool iteration (lots of tool results to process): escalate.
  if (previousToolCallCount >= 4) return STRONG;

  // Long tool results in recent messages: escalate.
  const recentMessages = messages.slice(-3);
  const hasLongToolResults = recentMessages.some(
    (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.length > 5000,
  );
  if (hasLongToolResults) return STRONG;

  // Follow-up iterations: cheap model for tool routing and summaries.
  return CHEAP;
}

export async function* runOpenRouterChat(
  this: LocalOrchestrator,
  userMessage: string,
  sessionId: string,
  provider: OpenRouterProvider,
  options?: ChannelChatOptions,
  seedMessages?: MessageParam[],
  turn?: ChatTurnOptions,
): AsyncGenerator<OrchestratorEvent> {
    // Per-turn config snapshot (bug #6 fix). Read effectiveModel from the
    // turn options first; fall back to the instance field for legacy callers.
    const effectiveModel = (turn?.orchestratorModel?.trim()) || this.orchestratorModel;
    const chatLog = logger.child({ chatTraceId: turn?.chatTraceId ?? sessionId.slice(0, 8) });
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
    chatLog.info({ toolCount: openaiTools.length, sections: [...(sections ?? [])] }, '[orchestrator] OpenRouter path tool list');

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
    const modelId = effectiveModel || 'x-ai/grok-4.20';
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
        ?? selectModelForIteration(this.orchestratorModel, iteration, loopMessages, prevIterToolCount, iterHadErrors);
      if (iteration === 0 || iterModel !== (effectiveModel || 'x-ai/grok-4.1-fast')) {
        chatLog.debug({ iteration, model: iterModel, persona: activePersona?.name }, '[orchestrator] iteration model selected');
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
      const iterStartMs = Date.now();
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
          chatLog.warn({ err: err.message, model: iterModel, iteration }, '[orchestrator] OpenRouter model call timed out');
          yield { type: 'text', content: `Model call timed out after ${Math.round(err.elapsedMs / 1000)}s (${iterModel}). Try again or pick a different model.` };
          throw err; // propagate so the async dispatch flips status='error'
        }
        logger.error({ err }, '[orchestrator] OpenRouter tool loop error');
        yield { type: 'text', content: 'Something went wrong with the AI provider. Try again.' };
        break;
      } finally {
        orStreamTimer.cancel();
      }

      // Record per-iteration telemetry. The orchestrator chat loop calls the
      // provider directly, bypassing llm-organ, so without this write there
      // is no llm_calls row and every cost/token aggregation reads 0.
      await recordLlmCallTelemetry(
        { db: this.db, workspaceId: this.workspaceId },
        {
          purpose: 'orchestrator_chat',
          provider: response.provider,
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costCents: response.costCents ?? 0,
          latencyMs: Date.now() - iterStartMs,
          success: true,
        },
      );

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

      // Tool results were already pushed as role='tool' messages above this
      // iteration, and OpenRouter cloud models (Grok, Sonnet, Flash, Mimo…)
      // parse role='tool' natively. The old code concatenated every result
      // into a second `[Tool Results: …]` text block and re-pushed it as a
      // role='user' reflection, so every tool output lived in loopMessages
      // twice per iteration — and the duplicated user-role copy was invisible
      // to compactStaleOpenAIToolResults (which only walks role='tool'),
      // doubling context growth across long tool loops. Reflection now only
      // carries the stagnation nudge + the reflection prompt, both of which
      // add signal the model can't derive from the tool messages alone.
      //
      // The Ollama path keeps its own inline duplication intentionally as a
      // fallback for small models that don't parse role='tool' reliably.
      const reflectionContent = stagnationWarning
        ? `${stagnationWarning}\n\n${reflectionText}`
        : reflectionText;

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

      // Mid-loop context budget check.
      //
      // The old metric (`totalInputTokens / contextLimit`) is CUMULATIVE work
      // across every iteration's request, not the current context fill. After
      // 20 iterations a healthy loop reads as "539% context" while the actual
      // next-call payload is well under the break threshold. That broke both
      // the observability log and the summarize trigger: the log screamed
      // about an overflow that wasn't happening, and the summarize call fired
      // every other iteration even when loopMessages was already compact.
      //
      // Current load mirrors what checkTurnTokenBudget measures at the top of
      // the next iteration, so the warn/summarize thresholds now line up with
      // the hard break guard instead of drifting.
      iterationsSinceSummarize++;
      const currentStaticTokens = estimateTokens(systemPrompt) + toolTokenCount;
      const currentMessageTokens = estimateMessagesTokens(loopMessages);
      const usableContext = Math.max(1, contextLimit - 4096);
      const utilizationPct = (currentStaticTokens + currentMessageTokens) / usableContext;
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
