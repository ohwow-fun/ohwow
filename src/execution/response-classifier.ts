/**
 * Agent-response classification helpers. Pure functions — no class state,
 * no DB access. Used by RuntimeEngine.executeTask to decide whether an
 * agent's final text reply should be auto-materialized into a deliverable
 * row and what type label to give it.
 */

export interface ResponseMeta {
  type: 'deliverable' | 'informational' | null;
  cleanContent: string;
}

/**
 * Parse an optional `<!--response_meta:{...}-->` header prefix the agent
 * can emit to explicitly label its reply. Returns { type: null } when no
 * header is present or when the JSON doesn't parse.
 */
export function parseResponseMeta(content: string): ResponseMeta {
  const match = content.match(/^<!--response_meta:(.*?)-->\s*/);
  if (!match) return { type: null, cleanContent: content };
  try {
    const meta = JSON.parse(match[1]);
    if (meta.type === 'deliverable' || meta.type === 'informational') {
      return {
        type: meta.type,
        cleanContent: content.replace(/^<!--response_meta:.*?-->\s*/, ''),
      };
    }
  } catch {
    // Unparseable — fall through.
  }
  return { type: null, cleanContent: content };
}

/**
 * Heuristic: determine if an untagged agent response should auto-create
 * a deliverable row. Skips trivially short replies and system/heartbeat
 * tasks; counts structure signals (headers, lists, code blocks, tables)
 * and applies length gates to decide.
 */
export function shouldAutoCreateDeliverable(
  content: string,
  task: { title: string; sourceType?: string | null },
): { create: boolean; inferredType: string } {
  const NO = { create: false, inferredType: 'other' };

  // Skip trivially short responses.
  if (content.length < 200) return NO;

  // Skip system/heartbeat/internal tasks.
  const lowerTitle = task.title.toLowerCase();
  const systemPrefixes = ['heartbeat', 'health check', 'system:', 'internal:', 'ping', 'cron:'];
  if (systemPrefixes.some((p) => lowerTitle.startsWith(p))) return NO;
  if (task.sourceType === 'heartbeat' || task.sourceType === 'system') return NO;

  // Structure signals.
  const hasHeaders = /^#{1,3}\s/m.test(content);
  const hasList = /^[-*]\s/m.test(content) || /^\d+\.\s/m.test(content);
  const hasCodeBlock = /```[\s\S]*?```/.test(content);
  const hasTable = /\|.*\|.*\|/m.test(content);
  const structureScore = [hasHeaders, hasList, hasCodeBlock, hasTable].filter(Boolean).length;

  // Substantial content (>500 chars) with any structure = deliverable.
  if (content.length > 500 && structureScore >= 1) {
    return { create: true, inferredType: inferTypeFromContent(content, lowerTitle) };
  }

  // Very long content (>1500 chars) even without structure.
  if (content.length > 1500) {
    return { create: true, inferredType: inferTypeFromContent(content, lowerTitle) };
  }

  // Medium content (200-500) with strong structure (2+ signals).
  if (content.length >= 200 && structureScore >= 2) {
    return { create: true, inferredType: inferTypeFromContent(content, lowerTitle) };
  }

  return NO;
}

/** Infer a deliverable type label from content patterns and task title. */
export function inferTypeFromContent(content: string, lowerTitle: string): string {
  // Email patterns.
  if (/subject:|dear |regards|sincerely/i.test(content) &&
      (lowerTitle.includes('email') || lowerTitle.includes('outreach') || lowerTitle.includes('message'))) {
    return 'email';
  }

  // Code patterns.
  if (/```(ts|js|python|tsx|jsx|rust|go|java|sql|html|css|sh|bash)/i.test(content) ||
      lowerTitle.includes('code') || lowerTitle.includes('implement') || lowerTitle.includes('script')) {
    return 'code';
  }

  // Report patterns.
  if (lowerTitle.includes('report') || lowerTitle.includes('analysis') || lowerTitle.includes('audit') ||
      /executive summary|key findings|recommendations|conclusion/i.test(content)) {
    return 'report';
  }

  // Plan patterns.
  if (lowerTitle.includes('plan') || lowerTitle.includes('strategy') || lowerTitle.includes('roadmap') ||
      /phase \d|step \d|timeline|milestone/i.test(content)) {
    return 'plan';
  }

  // Data patterns.
  if (lowerTitle.includes('data') || lowerTitle.includes('spreadsheet') || lowerTitle.includes('csv') ||
      /\|.*\|.*\|/m.test(content)) {
    return 'data';
  }

  // Creative patterns.
  if (lowerTitle.includes('write') || lowerTitle.includes('draft') || lowerTitle.includes('blog') ||
      lowerTitle.includes('post') || lowerTitle.includes('article') || lowerTitle.includes('copy') ||
      lowerTitle.includes('creative') || lowerTitle.includes('story')) {
    return 'creative';
  }

  return 'document';
}
