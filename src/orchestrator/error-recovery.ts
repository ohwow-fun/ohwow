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
  /network/i,
  /timeout/i,
  /503/,
  /502/,
  /temporarily unavailable/i,
];

export function classifyError(error: string | Error): ErrorCategory {
  const msg = typeof error === 'string' ? error : error.message;

  // Specific categories first (most to least specific)
  if (/401|403|unauthorized|forbidden|invalid.*key|authentication.*fail/i.test(msg)) return 'auth';
  if (/429|rate.?limit|too many requests|quota.*exceeded/i.test(msg)) return 'rate_limit';
  if (/context.*length|token.*limit|too.*long|maximum.*context|content.*too.*large/i.test(msg)) return 'context_overflow';
  if (/unknown.?tool|no such tool|tool.*not.*found/i.test(msg)) return 'tool_not_found';
  if (/compile|type\s*error|cannot find module|unexpected.*eof|unterminated/i.test(msg)) return 'compile_error';
  if (/conflict|stale|outdated|merge conflict|diverged|behind.*main/i.test(msg)) return 'stale_state';
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
    description: 'Auto-trim context and retry',
    action: () => ({ recovered: true, action: 'context_trimmed', shouldRetry: true }),
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
    description: 'Retry with cleaned input',
    action: () => ({ recovered: true, action: 'retry_parse', shouldRetry: true }),
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
      if (category !== 'transient' || attempt === maxRetries) {
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

/** Map of tool names to suggested alternatives when a tool is broken. */
const TOOL_ALTERNATIVES: Record<string, string[]> = {
  scrape_url: ['deep_research', 'scrape_search'],
  scrape_search: ['deep_research', 'scrape_url'],
  deep_research: ['scrape_url', 'scrape_search'],
  send_whatsapp_message: ['send_telegram_message'],
  send_telegram_message: ['send_whatsapp_message'],
};
