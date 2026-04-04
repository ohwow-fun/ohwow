/**
 * Predictive Engine — Free Energy Minimization (Friston)
 *
 * "The brain is fundamentally an inference machine that is trying
 * to minimize the difference between its predictions and the
 * sensory input it receives." — Karl Friston
 *
 * The Free Energy Principle: organisms minimize surprise by building
 * generative models and acting to confirm predictions. When reality
 * contradicts expectation, that prediction error is the primary
 * learning signal.
 *
 * This engine subsumes and improves upon:
 * - stagnation.ts: Hash-window-3 detection becomes a special case of
 *   prediction error (we detect semantic repetition, not just identical hashes)
 * - CircuitBreaker: Raw failure count becomes context-aware prediction
 * - MCTS activation: Arbitrary threshold becomes confidence-driven
 *
 * How it works:
 * 1. Before tool execution: predict() estimates success/failure
 * 2. After tool execution: update() computes prediction error
 * 3. The brain uses prediction errors to:
 *    - Suggest alternative tools proactively
 *    - Activate MCTS planning when confidence drops
 *    - Enrich stagnation warnings with specific failure context
 */

import type { Prediction, PredictionError, TemporalFrame } from './types.js';
import type { ExperienceStream } from './experience-stream.js';
import type { ToolResult } from '../orchestrator/local-tool-types.js';
import { hashToolCall, detectStagnation } from '../lib/stagnation.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Confidence threshold below which MCTS planner should activate. */
const MCTS_ACTIVATION_THRESHOLD = 0.3;

/** Minimum data points before making a prediction (below this: return unknown). */
const MIN_DATA_POINTS = 3;

/** Window for "recent" tool statistics (ms). */
const STATS_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Maximum context entries per tool (memory guard). */
const MAX_CONTEXT_ENTRIES = 100;

/** Threshold for "similar" failure context (how many shared tokens). */
const CONTEXT_SIMILARITY_MIN_OVERLAP = 2;

// ============================================================================
// INTERNAL TYPES
// ============================================================================

interface ToolStats {
  totalAttempts: number;
  successes: number;
  failures: number;
  /** Per-context failure tracking (e.g., per domain, per input pattern). */
  contextualFailures: Map<string, { attempts: number; failures: number }>;
  /** Last N input hashes for stagnation detection (backward compat). */
  recentHashes: string[];
}

/** Suggested alternative when a tool is predicted to fail. */
const TOOL_ALTERNATIVES: Record<string, string[]> = {
  scrape_url: ['deep_research', 'scrape_search'],
  scrape_search: ['deep_research', 'scrape_url'],
  deep_research: ['scrape_url', 'scrape_search'],
  send_whatsapp_message: ['send_telegram_message'],
  send_telegram_message: ['send_whatsapp_message'],
};

// ============================================================================
// PREDICTIVE ENGINE
// ============================================================================

export class PredictiveEngine {
  private toolStats: Map<string, ToolStats> = new Map();
  private experienceStream: ExperienceStream;
  /** All tool call hashes across the session (for backward-compat stagnation). */
  private allHashes: string[] = [];

  constructor(experienceStream: ExperienceStream) {
    this.experienceStream = experienceStream;
  }

  // --------------------------------------------------------------------------
  // PREDICT — Before tool execution
  // --------------------------------------------------------------------------

  /**
   * Predict the outcome of a tool call before executing it.
   *
   * Returns a Prediction with confidence. The brain can use this to:
   * - Warn the LLM that this tool is likely to fail
   * - Suggest an alternative tool
   * - Skip the tool entirely if confidence in failure is very high
   */
  predict(
    toolName: string,
    input: unknown,
    _temporalFrame?: TemporalFrame,
  ): Prediction {
    const stats = this.toolStats.get(toolName);
    const contextKey = this.extractContextKey(toolName, input);

    // No data: maximum uncertainty
    if (!stats || stats.totalAttempts < MIN_DATA_POINTS) {
      return {
        target: toolName,
        expectedResult: 'success', // optimistic default
        confidence: 0.1, // very low confidence (we don't know)
        basis: 'insufficient data',
      };
    }

    // Check contextual failure rate first (more specific = more useful)
    if (contextKey) {
      const contextStats = stats.contextualFailures.get(contextKey);
      if (contextStats && contextStats.attempts >= MIN_DATA_POINTS) {
        const contextFailureRate = contextStats.failures / contextStats.attempts;

        if (contextFailureRate > 0.7) {
          const alternative = this.suggestAlternative(toolName);
          return {
            target: toolName,
            expectedResult: 'failure',
            confidence: Math.min(0.9, contextFailureRate),
            basis: `${toolName} fails ${Math.round(contextFailureRate * 100)}% of the time in context "${contextKey}"`,
            suggestedAlternative: alternative ?? undefined,
          };
        }
      }
    }

    // Check global tool success rate
    const successRate = stats.successes / stats.totalAttempts;
    const failureRate = 1 - successRate;

    if (failureRate > 0.6) {
      const alternative = this.suggestAlternative(toolName);
      return {
        target: toolName,
        expectedResult: 'failure',
        confidence: Math.min(0.85, failureRate),
        basis: `${toolName} has a ${Math.round(failureRate * 100)}% failure rate (${stats.failures}/${stats.totalAttempts})`,
        suggestedAlternative: alternative ?? undefined,
      };
    }

    // Check for semantic stagnation: similar failures in recent context
    const semanticStagnation = this.detectSemanticStagnation(toolName);
    if (semanticStagnation) {
      const alternative = this.suggestAlternative(toolName);
      return {
        target: toolName,
        expectedResult: 'failure',
        confidence: 0.7,
        basis: semanticStagnation,
        suggestedAlternative: alternative ?? undefined,
      };
    }

    return {
      target: toolName,
      expectedResult: successRate > 0.7 ? 'success' : 'partial',
      confidence: Math.min(0.85, successRate),
      basis: `${toolName} succeeds ${Math.round(successRate * 100)}% of the time`,
    };
  }

  // --------------------------------------------------------------------------
  // UPDATE — After tool execution
  // --------------------------------------------------------------------------

  /**
   * Update the predictive model after a tool execution.
   * Returns a PredictionError (the learning signal).
   */
  update(
    prediction: Prediction,
    toolName: string,
    input: unknown,
    result: ToolResult,
  ): PredictionError {
    const success = result.success;
    const actualResult = success ? 'success' : 'failure';

    // Update tool stats
    const stats = this.getOrCreateStats(toolName);
    stats.totalAttempts++;
    if (success) {
      stats.successes++;
    } else {
      stats.failures++;
    }

    // Update contextual stats
    const contextKey = this.extractContextKey(toolName, input);
    if (contextKey) {
      let contextStats = stats.contextualFailures.get(contextKey);
      if (!contextStats) {
        if (stats.contextualFailures.size < MAX_CONTEXT_ENTRIES) {
          contextStats = { attempts: 0, failures: 0 };
          stats.contextualFailures.set(contextKey, contextStats);
        }
      }
      if (contextStats) {
        contextStats.attempts++;
        if (!success) contextStats.failures++;
      }
    }

    // Track hash for backward-compat stagnation detection
    const hash = hashToolCall(toolName, input);
    stats.recentHashes.push(hash);
    if (stats.recentHashes.length > 10) stats.recentHashes.shift();
    this.allHashes.push(hash);

    // Compute prediction error
    const wasCorrect = prediction.expectedResult === actualResult;
    const delta = wasCorrect ? 0 : 1;

    const lesson = this.deriveLessonFromError(prediction, actualResult, toolName, contextKey);

    const error: PredictionError = {
      prediction,
      actualResult,
      delta,
      lesson,
      timestamp: Date.now(),
    };

    // Record to experience stream
    this.experienceStream.append(
      'tool_executed',
      { toolName, inputHash: hash, success, contextKey },
      'orchestrator',
    );

    if (delta > 0) {
      this.experienceStream.append(
        'prediction_error',
        { toolName, predicted: prediction.expectedResult, actual: actualResult, delta, lesson },
        'orchestrator',
      );
    }

    return error;
  }

  // --------------------------------------------------------------------------
  // STAGNATION — Subsumes stagnation.ts with richer detection
  // --------------------------------------------------------------------------

  /**
   * Check if the system is stagnating.
   * Backward-compatible: still uses hash-window-3 as one signal,
   * but adds semantic stagnation and prediction-error-based detection.
   */
  isStagnating(): boolean {
    // Classic hash-based detection (backward compat with stagnation.ts)
    if (detectStagnation(this.allHashes)) return true;

    // Prediction-error-based: 3+ consecutive prediction errors
    const recentErrors = this.experienceStream.query({
      types: ['prediction_error'],
      limit: 3,
    });
    if (recentErrors.length >= 3) {
      const allRecent = recentErrors.every(
        e => (Date.now() - e.timestamp) < 30000, // within last 30 seconds
      );
      if (allRecent) return true;
    }

    return false;
  }

  /**
   * Build an enriched stagnation warning using predictive context.
   * More actionable than the generic STAGNATION_PROMPT.
   */
  buildStagnationWarning(): string {
    // Find the most commonly failing tool in recent history
    const recentExecs = this.experienceStream.getRecentToolExecutions(6);
    const failingTools = recentExecs.filter(e => !e.success);

    if (failingTools.length === 0) {
      return '[SYSTEM NOTICE] You appear to be repeating the same actions without progress. Try a completely different approach or conclude your task.';
    }

    // Group by tool name
    const toolFailureCounts = new Map<string, number>();
    for (const exec of failingTools) {
      toolFailureCounts.set(exec.toolName, (toolFailureCounts.get(exec.toolName) ?? 0) + 1);
    }

    const [topFailingTool, failCount] = [...toolFailureCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0];

    const alternative = this.suggestAlternative(topFailingTool);
    const altSuggestion = alternative ? ` Try using ${alternative} instead.` : ' Try a completely different approach.';

    return `[SYSTEM NOTICE] ${topFailingTool} has failed ${failCount} times recently.${altSuggestion} If you have enough information, synthesize your answer now.`;
  }

  // --------------------------------------------------------------------------
  // MCTS ACTIVATION — Confidence-driven instead of threshold-based
  // --------------------------------------------------------------------------

  /**
   * Should the MCTS planner activate?
   *
   * Current logic (stagnation.ts): 3 identical hashes OR iteration midpoint.
   * New logic: activate when rolling prediction confidence drops below threshold.
   */
  shouldActivatePlanner(currentIteration: number, maxIterations: number): boolean {
    // Always activate on classic stagnation
    if (this.isStagnating()) return true;

    // Activate on low prediction accuracy
    const accuracy = this.experienceStream.getPredictionAccuracy(STATS_WINDOW_MS);
    if (accuracy < MCTS_ACTIVATION_THRESHOLD && this.allHashes.length >= MIN_DATA_POINTS) {
      logger.debug(
        { accuracy: accuracy.toFixed(3), threshold: MCTS_ACTIVATION_THRESHOLD },
        '[PredictiveEngine] Low prediction accuracy, activating MCTS',
      );
      return true;
    }

    // Still keep the midpoint check as a safety net
    if (maxIterations > 0 && currentIteration >= Math.floor(maxIterations / 2)) {
      return true;
    }

    return false;
  }

  // --------------------------------------------------------------------------
  // QUERY — For the brain and other modules
  // --------------------------------------------------------------------------

  /**
   * Get overall tool success rate.
   */
  getToolSuccessRate(toolName: string): number {
    const stats = this.toolStats.get(toolName);
    if (!stats || stats.totalAttempts === 0) return 0.5;
    return stats.successes / stats.totalAttempts;
  }

  /**
   * Check if a tool is novel (fewer than 3 recorded attempts).
   * Novel tool executions trigger curiosity affect rather than satisfaction.
   */
  isNovel(toolName: string): boolean {
    const stats = this.toolStats.get(toolName);
    return !stats || stats.totalAttempts < 3;
  }

  /**
   * Get contextual success rate for a tool.
   */
  getContextualSuccessRate(toolName: string, contextKey: string): number | null {
    const stats = this.toolStats.get(toolName);
    if (!stats) return null;
    const ctx = stats.contextualFailures.get(contextKey);
    if (!ctx || ctx.attempts < MIN_DATA_POINTS) return null;
    return 1 - (ctx.failures / ctx.attempts);
  }

  /**
   * Suggest an alternative tool when the given tool is likely to fail.
   */
  suggestAlternative(toolName: string): string | null {
    const alternatives = TOOL_ALTERNATIVES[toolName];
    if (!alternatives) return null;

    // Pick the alternative with the highest success rate
    let bestAlternative: string | null = null;
    let bestRate = 0;

    for (const alt of alternatives) {
      const rate = this.getToolSuccessRate(alt);
      if (rate > bestRate) {
        bestRate = rate;
        bestAlternative = alt;
      }
    }

    return bestAlternative;
  }

  /**
   * Get the all-session hash array for backward compatibility
   * with any code that still reads orchToolCallHashes directly.
   */
  getAllHashes(): string[] {
    return this.allHashes;
  }

  /**
   * Reset session state (for new conversation turns).
   */
  resetSession(): void {
    this.allHashes = [];
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private getOrCreateStats(toolName: string): ToolStats {
    let stats = this.toolStats.get(toolName);
    if (!stats) {
      stats = {
        totalAttempts: 0,
        successes: 0,
        failures: 0,
        contextualFailures: new Map(),
        recentHashes: [],
      };
      this.toolStats.set(toolName, stats);
    }
    return stats;
  }

  /**
   * Extract a context key from tool input for contextual prediction.
   * For URL-based tools, this is the domain. For others, a hash of key fields.
   */
  private extractContextKey(toolName: string, input: unknown): string | null {
    if (!input || typeof input !== 'object') return null;
    const inputObj = input as Record<string, unknown>;

    // URL-based tools: extract domain
    if (toolName === 'scrape_url' || toolName === 'browser_navigate' || toolName === 'scrape_search') {
      const url = inputObj.url as string | undefined;
      if (url) {
        try {
          return new URL(url).hostname;
        } catch {
          return null;
        }
      }
      const query = inputObj.query as string | undefined;
      if (query) return `query:${query.slice(0, 50)}`;
    }

    // Messaging tools: extract channel
    if (toolName.startsWith('send_')) {
      const chatId = inputObj.chat_id as string | undefined;
      return chatId ? `chat:${chatId}` : null;
    }

    // Agent tools: extract agent name
    if (toolName === 'run_agent') {
      return `agent:${inputObj.agent_name ?? inputObj.agent_id ?? 'unknown'}`;
    }

    return null;
  }

  /**
   * Detect semantic stagnation: the agent is trying different variations
   * of the same failing approach (not identical hashes, but same tool
   * failing on similar contexts).
   */
  private detectSemanticStagnation(toolName: string): string | null {
    const stats = this.toolStats.get(toolName);
    if (!stats) return null;

    // Check if the last 3 attempts of this tool all failed
    const recentExecs = this.experienceStream.getRecentToolExecutions(10);
    const toolExecs = recentExecs.filter(e => e.toolName === toolName);
    const recentToolExecs = toolExecs.slice(-3);

    if (recentToolExecs.length >= 3 && recentToolExecs.every(e => !e.success)) {
      return `${toolName} has failed in the last 3 consecutive attempts with different inputs. The approach itself may be wrong.`;
    }

    return null;
  }

  /**
   * Derive a human-readable lesson from a prediction error.
   */
  private deriveLessonFromError(
    prediction: Prediction,
    actual: string,
    toolName: string,
    contextKey: string | null,
  ): string {
    if (prediction.expectedResult === 'success' && actual === 'failure') {
      const ctx = contextKey ? ` in context "${contextKey}"` : '';
      return `Expected ${toolName} to succeed${ctx}, but it failed. Consider an alternative approach.`;
    }

    if (prediction.expectedResult === 'failure' && actual === 'success') {
      const ctx = contextKey ? ` in context "${contextKey}"` : '';
      return `Expected ${toolName} to fail${ctx}, but it succeeded. The tool may be more reliable than estimated.`;
    }

    return `Prediction for ${toolName} was correct.`;
  }
}
