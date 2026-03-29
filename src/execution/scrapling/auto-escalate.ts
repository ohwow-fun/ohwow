/**
 * Auto-Escalation Logic
 *
 * Tries fast HTTP first, then stealth, then dynamic.
 * Detects Cloudflare challenges, bot-detection pages, and empty responses.
 * Global timeout of 60s prevents worst-case 90s+ hangs.
 */

import type { ScraplingService } from './scrapling.service.js';
import type { ScraplingResponse, FetchTier, ScraplingFetchOptions } from './scrapling-types.js';

const GLOBAL_TIMEOUT_MS = 60000; // 60s max across all tiers

/** Patterns that indicate a bot-detection or challenge page. */
const CHALLENGE_PATTERNS = [
  'cf-mitigated',
  'cf-challenge',
  'Checking your browser',
  'Just a moment...',
  'Enable JavaScript and cookies to continue',
  'Attention Required! | Cloudflare',
  'Access denied',
  'DDoS protection by',
  'Pardon Our Interruption',
  'Please verify you are a human',
  'One more step',
];

/** Error patterns that won't be fixed by escalation (host is unreachable). */
const FATAL_ERROR_PATTERNS = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'getaddrinfo',
  'ERR_NAME_NOT_RESOLVED',
];

/** Check if an error is a connection/DNS failure that won't be fixed by trying a different tier. */
function isFatalConnectionError(error: string): boolean {
  const lower = error.toLowerCase();
  return FATAL_ERROR_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

/** Check if a response indicates bot detection or a challenge. */
function isChallengeResponse(response: ScraplingResponse): boolean {
  if (response.status === 403 || response.status === 503) return true;
  if (response.error) return false;

  const html = response.html.toLowerCase();
  return CHALLENGE_PATTERNS.some(pattern => html.includes(pattern.toLowerCase()));
}

/** Check if the response has meaningful content. */
function isEmptyContent(response: ScraplingResponse): boolean {
  if (response.error) return true;
  // Strip tags roughly and check text length
  const textOnly = response.html.replace(/<[^>]*>/g, '').trim();
  return textOnly.length < 100;
}

export interface AutoEscalateResult {
  response?: ScraplingResponse;
  tier: FetchTier;
  error?: string;
  escalated: boolean;
}

/**
 * Fetch with automatic escalation through tiers:
 * 1. Fast HTTP fetch
 * 2. Stealth fetch (if fast got blocked)
 * 3. Dynamic fetch (if stealth also failed)
 *
 * Global timeout of 60s ensures the total wait never exceeds ~1 minute.
 */
export async function autoEscalateFetch(
  service: ScraplingService,
  url: string,
  opts?: ScraplingFetchOptions,
): Promise<AutoEscalateResult> {
  const deadline = Date.now() + GLOBAL_TIMEOUT_MS;

  // Tier 1: Fast HTTP
  try {
    const response = await service.fetch(url, opts);
    if (!response.error && !isChallengeResponse(response) && !isEmptyContent(response)) {
      return { response, tier: 'fast', escalated: false };
    }
    // Check for fatal connection errors before escalating
    if (response.error && isFatalConnectionError(response.error)) {
      return { error: response.error, tier: 'fast', escalated: false };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isFatalConnectionError(msg)) {
      return { error: msg, tier: 'fast', escalated: false };
    }
    // Fall through to stealth
  }

  // Check global timeout before next tier
  if (Date.now() >= deadline) {
    return { error: 'Auto-escalation timed out after fast tier', tier: 'fast', escalated: false };
  }

  // Tier 2: Stealth (Camoufox)
  try {
    const response = await service.stealthFetch(url, opts);
    if (!response.error && !isChallengeResponse(response) && !isEmptyContent(response)) {
      return { response, tier: 'stealth', escalated: true };
    }
  } catch {
    // Fall through to dynamic
  }

  // Check global timeout before next tier
  if (Date.now() >= deadline) {
    return { error: 'Auto-escalation timed out after stealth tier', tier: 'stealth', escalated: true };
  }

  // Tier 3: Dynamic (Playwright Chromium)
  try {
    const response = await service.dynamicFetch(url, opts);
    if (response.error) {
      return { error: response.error, tier: 'dynamic', escalated: true };
    }
    return { response, tier: 'dynamic', escalated: true };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'All fetch tiers failed',
      tier: 'dynamic',
      escalated: true,
    };
  }
}
