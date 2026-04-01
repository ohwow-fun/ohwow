import type { SomaticMarker, SomaticMatch } from './types.js';

/**
 * Match somatic markers against current context.
 * Returns markers sorted by relevance (exact context match > partial).
 */
export function matchSomaticMarkers(
  contextHash: string,
  toolName: string | null,
  markers: SomaticMarker[],
): SomaticMatch[] {
  const matches: SomaticMatch[] = [];

  for (const marker of markers) {
    let relevance = 0;

    // Exact context match
    if (marker.contextHash === contextHash) {
      relevance = 1.0;
    }
    // Same tool, different context
    else if (toolName && marker.toolName === toolName) {
      relevance = 0.4;
    }

    if (relevance > 0) {
      matches.push({ marker, relevance });
    }
  }

  return matches.sort((a, b) => b.relevance - a.relevance);
}

/**
 * Create a context hash from tool name and intent for somatic marker lookup.
 * Simple but deterministic.
 */
export function createContextHash(toolName: string, intent: string): string {
  // Simple hash: combine tool + intent first 50 chars
  const raw = `${toolName}:${intent.slice(0, 50)}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Summarize somatic marker warnings for prompt injection.
 * Returns human-readable warnings about negative markers.
 */
export function summarizeSomaticWarnings(matches: SomaticMatch[]): string | null {
  const negativeMatches = matches.filter(m => m.marker.outcome === 'negative' && m.relevance >= 0.4);

  if (negativeMatches.length === 0) return null;

  const warnings = negativeMatches.slice(0, 3).map(m => {
    const tool = m.marker.toolName ?? 'this approach';
    return `Past experience with ${tool}: ${m.marker.affect} (outcome was negative)`;
  });

  return warnings.join('. ') + '.';
}
