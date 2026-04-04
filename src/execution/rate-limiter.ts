/**
 * Rate Limiter — Token Bucket for API Providers
 * Prevents rate limit errors by queuing requests when approaching limits.
 * Designed for Anthropic API rate limits on the local runtime.
 */

import { logger } from '../lib/logger.js';

interface TokenBucket {
  requestTokens: number;
  tokenTokens: number;
  lastRefill: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
}

const DEFAULT_REQUESTS_PER_MINUTE = 50;
const DEFAULT_TOKENS_PER_MINUTE = 100_000;

export class RateLimiter {
  private bucket: TokenBucket;
  /**
   * Homeostasis modulation factor (0.1–1.0).
   * When homeostasis detects resource overuse, this reduces effective capacity
   * to throttle the system metabolically rather than hitting hard rate limits.
   */
  private homeostasisFactor = 1.0;

  constructor(
    requestsPerMinute = DEFAULT_REQUESTS_PER_MINUTE,
    tokensPerMinute = DEFAULT_TOKENS_PER_MINUTE,
  ) {
    this.bucket = {
      requestTokens: requestsPerMinute,
      tokenTokens: tokensPerMinute,
      lastRefill: Date.now(),
      requestsPerMinute,
      tokensPerMinute,
    };
  }

  /** Set homeostasis modulation factor (0.1–1.0). Lower values throttle more aggressively. */
  setHomeostasisModifier(factor: number): void {
    this.homeostasisFactor = Math.max(0.1, Math.min(1.0, factor));
    if (factor < 1.0) {
      logger.debug({ factor: this.homeostasisFactor }, 'rate-limiter: homeostasis throttle active');
    }
  }

  /**
   * Wait until a request can proceed.
   * Returns immediately if within limits, otherwise waits.
   */
  async waitForCapacity(estimatedTokens = 1000): Promise<void> {
    this.refill();

    // Apply homeostasis modulation: reduce effective capacity under metabolic stress
    const effectiveRequestCap = this.bucket.requestsPerMinute * this.homeostasisFactor;
    const effectiveTokenCap = this.bucket.tokensPerMinute * this.homeostasisFactor;

    if (this.bucket.requestTokens >= 1 && this.bucket.tokenTokens >= estimatedTokens
        && this.bucket.requestTokens <= effectiveRequestCap && this.bucket.tokenTokens <= effectiveTokenCap) {
      return;
    }

    // Also allow through if within base limits (homeostasis only slows, doesn't block)
    if (this.bucket.requestTokens >= 1 && this.bucket.tokenTokens >= estimatedTokens) {
      return;
    }

    // Calculate wait time
    const requestWait = this.bucket.requestTokens < 1
      ? ((1 - this.bucket.requestTokens) / this.bucket.requestsPerMinute) * 60_000
      : 0;
    const tokenWait = this.bucket.tokenTokens < estimatedTokens
      ? ((estimatedTokens - this.bucket.tokenTokens) / this.bucket.tokensPerMinute) * 60_000
      : 0;

    const waitMs = Math.min(Math.ceil(Math.max(requestWait, tokenWait)), 30_000);

    if (waitMs > 0) {
      logger.debug({ waitMs, estimatedTokens }, 'Rate limiter: waiting for capacity');
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refill();
    }
  }

  /**
   * Consume tokens after a request completes.
   */
  consume(actualTokens: number): void {
    this.bucket.requestTokens = Math.max(0, this.bucket.requestTokens - 1);
    this.bucket.tokenTokens = Math.max(0, this.bucket.tokenTokens - actualTokens);
  }

  /**
   * Handle a 429 response. Drain the bucket.
   */
  recordRateLimit(retryAfterMs?: number): void {
    this.bucket.requestTokens = 0;
    this.bucket.tokenTokens = 0;
    if (retryAfterMs) {
      this.bucket.lastRefill = Date.now() + retryAfterMs - 60_000;
    }
    logger.warn({ retryAfterMs }, 'Rate limit hit');
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMinutes = (now - this.bucket.lastRefill) / 60_000;
    if (elapsedMinutes <= 0) return;

    this.bucket.requestTokens = Math.min(
      this.bucket.requestsPerMinute,
      this.bucket.requestTokens + this.bucket.requestsPerMinute * elapsedMinutes,
    );
    this.bucket.tokenTokens = Math.min(
      this.bucket.tokensPerMinute,
      this.bucket.tokenTokens + this.bucket.tokensPerMinute * elapsedMinutes,
    );
    this.bucket.lastRefill = now;
  }
}
