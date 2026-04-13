/**
 * Error recovery utilities for the orchestrator.
 * Provides retry logic for transient failures and circuit breakers per tool.
 */

// ============================================================================
// ERROR CLASSIFICATION
// ============================================================================

export type ErrorCategory =
  | 'transient'
  | 'permanent'
  | 'parse'
  | 'auth'
  | 'rate_limit'
  | 'context_overflow'
  | 'tool_not_found'
  | 'compile_error'
  | 'stale_state';

const NETWORK_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENETUNREACH/i,
  /socket hang up/i,
  /\bnetwork\b.*(?:error|fail|unavailable|unreachable)/i,
  /\b(?:connection.*timeout|request.*timeout|read.*timeout)\b/i,
  /\b503\b/,
  /\b502\b/,
  /temporarily unavailable/i,
];

export function classifyError(error: string | Error): ErrorCategory {
  const msg = typeof error === 'string' ? error : error.message;

  // Specific categories first (most to least specific)
  if (/401|403|unauthorized|forbidden|invalid.*key|authentication.*fail/i.test(msg)) return 'auth';
  if (/429|rate.?limit|too many requests|quota.*exceeded/i.test(msg)) return 'rate_limit';
  if (/context.*length|token.*limit|too.*long|maximum.*context|content.*too.*large/i.test(msg)) return 'context_overflow';
  if (/unknown.?tool|no such tool|tool.*not.*found/i.test(msg)) return 'tool_not_found';
  if (/compile|cannot find module|unexpected.*eof|unterminated|type\s*error(?!.*(?:fetch|network|connect))/i.test(msg)) return 'compile_error';
  if (/merge.?conflict|git.*stale|branch.*outdated|branch.*diverged|behind.*(?:main|master)/i.test(msg)) return 'stale_state';
  if (NETWORK_PATTERNS.some(p => p.test(msg))) return 'transient';
  if (/parse|json|syntax|unexpected token/i.test(msg)) return 'parse';

  return 'permanent';
}

// ============================================================================
// RECOVERY RECIPES
// ============================================================================

export interface RecoveryContext {
  error: Error;
  toolName?: string;
  workingDirectory?: string;
}

export interface RecoveryOutcome {
  recovered: boolean;
  action: string;
  shouldRetry: boolean;
  userMessage?: string;
}

interface RecoveryRecipe {
  description: string;
  action: (ctx: RecoveryContext) => Promise<RecoveryOutcome> | RecoveryOutcome;
}

const RECOVERY_RECIPES: Record<ErrorCategory, RecoveryRecipe> = {
  transient: {
    description: 'Retry with exponential backoff',
    action: () => ({ recovered: true, action: 'retry_backoff', shouldRetry: true }),
  },
  rate_limit: {
    description: 'Wait and retry after rate limit cooldown',
    action: async () => {
      await new Promise(resolve => setTimeout(resolve, 30_000));
      return { recovered: true, action: 'rate_limit_wait_30s', shouldRetry: true };
    },
  },
  context_overflow: {
    description: 'Signal context overflow to caller for trimming',
    action: () => ({
      recovered: false,
      action: 'context_overflow_detected',
      shouldRetry: false,
      userMessage: 'Request exceeds model context window. The conversation will be automatically trimmed.',
    }),
  },
  auth: {
    description: 'Surface authentication error to user',
    action: (ctx) => ({
      recovered: false,
      action: 'auth_error_surfaced',
      shouldRetry: false,
      userMessage: `Authentication failed: ${ctx.error.message}. Check your API key or credentials.`,
    }),
  },
  parse: {
    description: 'Surface parse error for correction',
    action: (ctx) => ({
      recovered: false,
      action: 'parse_error_surfaced',
      shouldRetry: false,
      userMessage: `Malformed response: ${ctx.error.message}`,
    }),
  },
  tool_not_found: {
    description: 'Suggest alternative tools',
    action: (ctx) => {
      const alternatives = ctx.toolName ? TOOL_ALTERNATIVES[ctx.toolName] : undefined;
      const suggestion = alternatives ? ` Try ${alternatives.join(' or ')} instead.` : '';
      return {
        recovered: false,
        action: 'tool_not_found_suggested',
        shouldRetry: false,
        userMessage: `Tool "${ctx.toolName}" not found.${suggestion}`,
      };
    },
  },
  compile_error: {
    description: 'Surface compile error output',
    action: (ctx) => ({
      recovered: false,
      action: 'compile_error_surfaced',
      shouldRetry: false,
      userMessage: ctx.error.message,
    }),
  },
  stale_state: {
    description: 'Detect stale state and suggest refresh',
    action: () => ({
      recovered: false,
      action: 'stale_state_detected',
      shouldRetry: false,
      userMessage: 'State appears stale or conflicted. Try pulling the latest changes and retrying.',
    }),
  },
  permanent: {
    description: 'Unrecoverable error',
    action: (ctx) => ({
      recovered: false,
      action: 'permanent_error',
      shouldRetry: false,
      userMessage: ctx.error.message,
    }),
  },
};

/**
 * Attempt structured recovery for an error.
 * One-attempt-then-escalate: tries the recipe once, surfaces to user if it fails.
 */
export async function attemptRecovery(
  error: Error,
  ctx: RecoveryContext,
): Promise<RecoveryOutcome> {
  const category = classifyError(error);
  const recipe = RECOVERY_RECIPES[category];
  const startTime = Date.now();

  try {
    const outcome = await recipe.action(ctx);
    outcome.action = `${category}:${outcome.action}`;
    return outcome;
  } catch (recoveryError) {
    // Recovery itself failed — escalate to user
    const duration = Date.now() - startTime;
    return {
      recovered: false,
      action: `${category}:recovery_failed_after_${duration}ms`,
      shouldRetry: false,
      userMessage: `Recovery failed: ${error.message}`,
    };
  }
}

// ============================================================================
// RETRY WITH BACKOFF
// ============================================================================

const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_MS = [1000, 3000];

/**
 * Retry an async function with exponential backoff for transient errors only.
 * Returns the result on success, or throws the last error on exhaustion.
 *
 * When the immune system is at critical/quarantine alert level, retries are
 * suppressed to prevent amplification of potential attacks.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  maxRetries = DEFAULT_MAX_RETRIES,
  immuneAlertLevel?: string,
): Promise<T> {
  // Under high immune alert, suppress retries to avoid amplifying threats
  const effectiveRetries = (immuneAlertLevel === 'critical' || immuneAlertLevel === 'quarantine')
    ? 0
    : maxRetries;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const category = classifyError(lastError);

      // Only retry transient errors
      if (category !== 'transient' || attempt === effectiveRetries) {
        throw lastError;
      }

      const delay = BACKOFF_MS[attempt] ?? 3000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

interface CircuitState {
  failures: number;
  lastFailure: number;
  disabled: boolean;
}

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 5 * 60 * 1000; // 5 minutes

export class CircuitBreaker {
  private circuits = new Map<string, CircuitState>();

  /** Check if a tool is currently disabled by the circuit breaker. */
  isDisabled(toolName: string): boolean {
    const state = this.circuits.get(toolName);
    if (!state || !state.disabled) return false;

    // Auto-reset after cooldown period
    if (Date.now() - state.lastFailure > CIRCUIT_RESET_MS) {
      state.disabled = false;
      state.failures = 0;
      return false;
    }

    return true;
  }

  /**
   * Record a tool failure. Returns true if the circuit just tripped.
   * Safe in single-threaded JS: recordFailure() is synchronous,
   * so failures++ and the threshold check cannot be interleaved
   * by other async operations (Promise.allSettled schedules generators
   * independently, but synchronous code within each runs atomically).
   */
  recordFailure(toolName: string): boolean {
    let state = this.circuits.get(toolName);
    if (!state) {
      state = { failures: 0, lastFailure: 0, disabled: false };
      this.circuits.set(toolName, state);
    }

    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= CIRCUIT_FAILURE_THRESHOLD && !state.disabled) {
      state.disabled = true;
      return true;
    }

    return false;
  }

  /** Record a tool success (resets failure count). */
  recordSuccess(toolName: string): void {
    const state = this.circuits.get(toolName);
    if (state) {
      state.failures = 0;
      state.disabled = false;
    }
  }

  /** Get list of currently disabled tools. */
  getDisabledTools(): string[] {
    return [...this.circuits.entries()]
      .filter(([, state]) => state.disabled && Date.now() - state.lastFailure <= CIRCUIT_RESET_MS)
      .map(([name]) => name);
  }

  /** Build an error message with alternative tool suggestions. */
  buildErrorWithAlternatives(toolName: string, originalError: string): string {
    const alternatives = TOOL_ALTERNATIVES[toolName];
    const altSuggestion = alternatives
      ? ` Try using ${alternatives.join(' or ')} instead.`
      : '';
    return `${originalError}${altSuggestion}`;
  }
}

// ============================================================================
// CONSECUTIVE FAILURE BREAKER (per-turn)
// ============================================================================
//
// CircuitBreaker above is process-global: it tracks cumulative failures across
// every turn and resets after 5 minutes. That's the right shape for "tool X
// has been flaky all day, fall back to alternatives" but it does nothing for
// the fast pathology where a model gets confused inside a single turn and
// calls the same tool 4-5 times in a row, each time getting the exact same
// error back, until the loop hits maxIterations and burns 50 model calls of
// budget.
//
// ConsecutiveToolBreaker is instantiated fresh per loop invocation. It tracks
// only consecutive failures (a single success resets the counter) and decides
// when to nudge the model and when to hard-abort the turn.
//
// Decision flow:
//   - 1-2 consecutive failures: 'ok' (transient or self-correcting)
//   - 3rd failure:               'nudge' (inject a stop-and-rethink hint into
//                                 the next tool result)
//   - 4th failure:               'abort' (yield abort message, break loop)
//
// Nudge-then-abort gives the model exactly one chance to recover after being
// told "stop." Empirically this is what Claude Code does and it's enough for
// most genuine-confusion cases without being trigger-happy on transient
// failures (one bad fs read in the middle of a working sequence is fine).

export type BreakerDecision = 'ok' | 'nudge' | 'abort';

export const CONSECUTIVE_NUDGE_THRESHOLD = 3;
export const CONSECUTIVE_ABORT_THRESHOLD = 4;

interface ConsecutiveEntry {
  failures: number;
  lastError: string;
}

export class ConsecutiveToolBreaker {
  private counts = new Map<string, ConsecutiveEntry>();
  private nudged = new Set<string>();
  private aborted: { toolName: string; lastError: string; failures: number } | null = null;

  /**
   * Record the outcome of a single tool execution.
   * Returns 'ok' for success or 1-2 failures, 'nudge' on the 3rd consecutive
   * failure (only fires once per tool), and 'abort' on the 4th and beyond.
   */
  record(toolName: string, success: boolean, errorMessage?: string): BreakerDecision {
    if (success) {
      this.counts.delete(toolName);
      this.nudged.delete(toolName);
      return 'ok';
    }

    const entry = this.counts.get(toolName) ?? { failures: 0, lastError: '' };
    entry.failures += 1;
    if (errorMessage) entry.lastError = errorMessage;
    this.counts.set(toolName, entry);

    if (entry.failures >= CONSECUTIVE_ABORT_THRESHOLD) {
      this.aborted = { toolName, lastError: entry.lastError, failures: entry.failures };
      return 'abort';
    }
    if (entry.failures === CONSECUTIVE_NUDGE_THRESHOLD && !this.nudged.has(toolName)) {
      this.nudged.add(toolName);
      return 'nudge';
    }
    return 'ok';
  }

  /** Whether the breaker has flipped into abort state from a prior record() call. */
  isAborted(): boolean {
    return this.aborted !== null;
  }

  /**
   * Build a stop-and-rethink message to inject into the next tool result content.
   * Triggered on the 3rd consecutive failure; the model gets one shot to adapt.
   */
  buildNudgeMessage(toolName: string): string {
    const entry = this.counts.get(toolName);
    const failures = entry?.failures ?? CONSECUTIVE_NUDGE_THRESHOLD;
    const lastError = entry?.lastError || 'no error message';
    return (
      `\n\n[CONSECUTIVE FAILURE WARNING] Tool "${toolName}" has failed ` +
      `${failures} times in a row with: ${lastError}. Stop calling this tool. ` +
      `Either try a completely different approach or report the failure to ` +
      `the user and end the turn. The next consecutive failure will hard-abort ` +
      `this turn.`
    );
  }

  /** Build the user-visible abort message that gets yielded before breaking the loop. */
  buildAbortMessage(): string {
    if (!this.aborted) return '';
    return (
      `[TURN ABORTED] Tool "${this.aborted.toolName}" failed ` +
      `${this.aborted.failures} times in a row with: ${this.aborted.lastError}. ` +
      `Aborting turn to prevent an infinite tool loop. Please review what was ` +
      `attempted and try a different approach.`
    );
  }

  /** Inspect the abort state for structured event emission. */
  getAbortState(): { toolName: string; lastError: string; failures: number } | null {
    return this.aborted;
  }
}

/** Map of tool names to suggested alternatives when a tool is broken. */
const TOOL_ALTERNATIVES: Record<string, string[]> = {
  scrape_url: ['deep_research', 'scrape_search'],
  scrape_search: ['deep_research', 'scrape_url'],
  deep_research: ['scrape_url', 'scrape_search'],
  send_whatsapp_message: ['send_telegram_message'],
  send_telegram_message: ['send_whatsapp_message'],
};
