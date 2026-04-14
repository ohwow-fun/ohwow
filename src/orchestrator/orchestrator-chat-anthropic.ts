/**
 * Anthropic chat loop — the ~760-LOC inline body of LocalOrchestrator.runChat's
 * Anthropic branch, lifted into a standalone async generator. Invoked from
 * the dispatcher via `yield* runAnthropicChat.call(this, ...)` so the `this:`
 * parameter carries the orchestrator instance.
 *
 * The `this: LocalOrchestrator` parameter makes TypeScript treat the
 * function body as if it were a method on the class: private-field access,
 * getter reads, mutable field writes, and method calls all stay legal with
 * zero interface boilerplate. The `LocalOrchestrator` import is type-only
 * to avoid a runtime circular dependency — the orchestrator imports this
 * module, and this module only needs the class for type annotations.
 */

import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  TextBlock,
  TextBlockParam,
  ContentBlock,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalOrchestrator } from './local-orchestrator.js';
import type {
  ChannelChatOptions,
  OrchestratorEvent,
  ChatTurnOptions,
} from './orchestrator-types.js';
import {
  MODEL,
  MAX_ITERATIONS,
  MODE_MAX_ITERATIONS,
} from './orchestrator-types.js';
import { CLAUDE_CONTEXT_LIMITS } from '../execution/ai-types.js';
import {
  REQUEST_BROWSER_TOOL,
  BROWSER_TOOL_DEFINITIONS,
} from '../execution/browser/browser-tools.js';
import {
  REQUEST_DESKTOP_TOOL,
  DESKTOP_TOOL_DEFINITIONS,
} from '../execution/desktop/desktop-tools.js';
import { LocalDesktopService } from '../execution/desktop/local-desktop.service.js';
import { buildDisplayLayout } from '../execution/desktop/screenshot-capture.js';
import {
  FILESYSTEM_TOOL_DEFINITIONS,
  BASH_TOOL_DEFINITIONS,
  REQUEST_FILE_ACCESS_TOOL,
} from './tool-definitions.js';
import { invalidateFileAccessCache } from './tools/filesystem.js';
import { invalidateBashAccessCache } from './tools/bash.js';
import { ContextBudget, estimateTokens, estimateToolTokens } from './context-budget.js';
import type { ToolResult } from './local-tool-types.js';
import { convertToolsToOpenAI } from '../execution/tool-format.js';
import { extractToolCallsFromText } from '../execution/text-tool-parse.js';
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
  buildAnthropicTurnMessages,
  extractOrchestratorMemory,
} from './session-store.js';
import { reflectOnWikiOpportunities } from './wiki-reflector.js';
import {
  compactStaleToolResults,
  checkTurnTokenBudget,
  estimateMessagesTokens,
  buildBudgetExitMessage,
} from './turn-context-guard.js';
import {
  executeToolCall,
  type ToolCallRequest,
} from './tool-executor.js';
import { executeToolCallsBatch } from './batch-executor.js';
import { ConsecutiveToolBreaker } from './error-recovery.js';
import { hashToolCall } from '../lib/stagnation.js';
import { logger } from '../lib/logger.js';
import { withTimeout } from '../lib/with-timeout.js';
import crypto from 'crypto';

/**
 * Per-iteration model call timeout. Applies to every anthropic.messages.create
 * call inside the Anthropic tool loop. 5 minutes is generous enough for healthy
 * slow responses (large context, complex tool use) but short enough that a
 * hung upstream API gets caught within the user's patience window. Override
 * via OHWOW_MODEL_CALL_TIMEOUT_MS. Kept in sync with the constant in
 * local-orchestrator.ts — bug #6 fix.
 */
const MODEL_CALL_TIMEOUT_MS = (() => {
  const fromEnv = parseInt(process.env.OHWOW_MODEL_CALL_TIMEOUT_MS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 300_000;
})();

export async function* runAnthropicChat(
  this: LocalOrchestrator,
  userMessage: string,
  sessionId: string,
  options: ChannelChatOptions | undefined,
  seedMessages: MessageParam[] | undefined,
  turn: ChatTurnOptions | undefined,
  effectiveModel: string,
): AsyncGenerator<OrchestratorEvent> {
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
    const hasAbundantContext = !effectiveModel ||
      effectiveModel.startsWith('claude-') ||
      (CLAUDE_CONTEXT_LIMITS[effectiveModel as keyof typeof CLAUDE_CONTEXT_LIMITS] ?? 0) > 100_000;

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
      const anthropicCallLabel = `anthropic.messages.create (${effectiveModel || MODEL}, iter ${iteration})`;
      const response = await withTimeout(
        anthropicCallLabel,
        MODEL_CALL_TIMEOUT_MS,
        (signal) => this.anthropic.messages.create(
          {
            model: effectiveModel || MODEL,
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

      // Mid-loop context budget check for Anthropic path.
      //
      // The old metric (`totalInputTokens / anthropicContextLimit`) is
      // CUMULATIVE work across every iteration's request, not the current
      // context fill. After a long tool loop it reported multi-hundred-percent
      // "context used" while the actual next-call payload was fine, breaking
      // both the observability log and the summarize trigger. Use the same
      // current-load estimator as the hard break guard above so warn and
      // summarize thresholds stay synchronized with the real context.
      iterationsSinceSummarize++;
      const currentStaticTokens = estimateTokens(systemBlocks.map(b => b.text).join('')) + estimateToolTokens(convertToolsToOpenAI(tools));
      const currentMessageTokens = estimateMessagesTokens(loopMessages);
      const usableContext = Math.max(1, anthropicContextLimit - 4096);
      const utilizationPct = (currentStaticTokens + currentMessageTokens) / usableContext;
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
