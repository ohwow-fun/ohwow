import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyError, retryTransient, CircuitBreaker } from '../error-recovery.js';

describe('classifyError', () => {
  it('classifies ECONNRESET as transient', () => {
    expect(classifyError('ECONNRESET')).toBe('transient');
  });

  it('classifies ETIMEDOUT as transient', () => {
    expect(classifyError('ETIMEDOUT')).toBe('transient');
  });

  it('classifies 429 Too Many Requests as rate_limit', () => {
    expect(classifyError('429 Too Many Requests')).toBe('rate_limit');
  });

  it('classifies 401 Unauthorized as auth', () => {
    expect(classifyError('401 Unauthorized')).toBe('auth');
  });

  it('classifies context length exceeded as context_overflow', () => {
    expect(classifyError('context length exceeded')).toBe('context_overflow');
  });

  it('classifies unknown tool as tool_not_found', () => {
    expect(classifyError('unknown tool: foo_bar')).toBe('tool_not_found');
  });

  it('classifies JSON.parse error as parse', () => {
    expect(classifyError('JSON.parse error')).toBe('parse');
  });

  it('classifies unexpected token as parse', () => {
    expect(classifyError('unexpected token')).toBe('parse');
  });

  it('classifies unknown errors as permanent', () => {
    expect(classifyError('unknown thing')).toBe('permanent');
  });

  it('handles Error objects with transient message', () => {
    expect(classifyError(new Error('timeout'))).toBe('transient');
  });

  it('classifies syntax error in response as parse', () => {
    expect(classifyError('syntax error in response')).toBe('parse');
  });
});

describe('retryTransient', () => {
  // Mock setTimeout to fire immediately (avoids fake timer + async rejection issues)
  let originalSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    originalSetTimeout = globalThis.setTimeout;
    // @ts-expect-error - simplified mock that fires callback immediately
    globalThis.setTimeout = (fn: () => void) => { fn(); return 0; };
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  it('succeeds on first try without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryTransient(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient error and succeeds on second try', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce('recovered');

    const result = await retryTransient(fn);

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on permanent error without retrying', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('invalid credentials'));

    await expect(retryTransient(fn)).rejects.toThrow('invalid credentials');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries and throws last error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(retryTransient(fn)).rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects custom maxRetries parameter', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(retryTransient(fn, 1)).rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on parse error without retrying', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('unexpected token'));

    await expect(retryTransient(fn)).rejects.toThrow('unexpected token');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker();
  });

  it('isDisabled returns false for unknown tool', () => {
    expect(breaker.isDisabled('nonexistent_tool')).toBe(false);
  });

  it('recordFailure returns false below threshold', () => {
    expect(breaker.recordFailure('scrape_url')).toBe(false);
    expect(breaker.recordFailure('scrape_url')).toBe(false);
  });

  it('recordFailure returns true at threshold (3)', () => {
    breaker.recordFailure('scrape_url');
    breaker.recordFailure('scrape_url');
    expect(breaker.recordFailure('scrape_url')).toBe(true);
  });

  it('isDisabled returns true after tripping', () => {
    breaker.recordFailure('scrape_url');
    breaker.recordFailure('scrape_url');
    breaker.recordFailure('scrape_url');
    expect(breaker.isDisabled('scrape_url')).toBe(true);
  });

  it('isDisabled auto-resets after CIRCUIT_RESET_MS', () => {
    vi.useFakeTimers();
    try {
      breaker.recordFailure('scrape_url');
      breaker.recordFailure('scrape_url');
      breaker.recordFailure('scrape_url');
      expect(breaker.isDisabled('scrape_url')).toBe(true);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(breaker.isDisabled('scrape_url')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recordSuccess resets failure count and disabled flag', () => {
    breaker.recordFailure('scrape_url');
    breaker.recordFailure('scrape_url');
    breaker.recordFailure('scrape_url');
    expect(breaker.isDisabled('scrape_url')).toBe(true);

    breaker.recordSuccess('scrape_url');
    expect(breaker.isDisabled('scrape_url')).toBe(false);
  });

  it('getDisabledTools returns only currently disabled tools', () => {
    breaker.recordFailure('scrape_url');
    breaker.recordFailure('scrape_url');
    breaker.recordFailure('scrape_url');

    breaker.recordFailure('deep_research');

    const disabled = breaker.getDisabledTools();
    expect(disabled).toEqual(['scrape_url']);
  });

  it('buildErrorWithAlternatives appends known alternatives', () => {
    const result = breaker.buildErrorWithAlternatives('scrape_url', 'Connection failed');
    expect(result).toBe('Connection failed Try using deep_research or scrape_search instead.');
  });

  it('buildErrorWithAlternatives with unknown tool returns original error', () => {
    const result = breaker.buildErrorWithAlternatives('unknown_tool', 'Something broke');
    expect(result).toBe('Something broke');
  });
});
