/**
 * Should-Sequence Heuristic (Local Runtime)
 *
 * Lightweight check: does this task warrant Sequential multi-agent
 * coordination or a single-agent run?
 *
 * Simpler than the cloud version — no OrchestratorBrain dependency.
 * Uses keyword patterns + agent count + model capability.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ShouldSequenceInput {
  prompt: string;
  agents: Array<{
    id: string;
    name: string;
    role: string;
  }>;
  /** Ollama model name (if local). Empty string or undefined for Anthropic. */
  ollamaModel?: string;
}

export interface ShouldSequenceResult {
  shouldSequence: boolean;
  reason: string;
  relevantAgentCount: number;
}

// ============================================================================
// COMPLEXITY KEYWORDS (inline, no external dependency)
// ============================================================================

const SIMPLE_KEYWORDS = [
  'check', 'get', 'list', 'find', 'send', 'look up', 'what is',
  'how many', 'status', 'show', 'tell me', 'remind', 'count',
];

const COMPLEX_KEYWORDS = [
  'analyze', 'compare', 'create a', 'design', 'plan', 'research',
  'evaluate', 'write a', 'build', 'strategy', 'investigate',
  'diagnose', 'optimize', 'draft a', 'develop', 'propose',
  'prepare', 'review and',
];

const MULTI_STEP_PATTERNS = [
  /first\b.*\bthen\b/i,
  /step\s*\d/i,
  /\d+\.\s+\w/,
  /\band\s+also\b/i,
  /\bafter\s+that\b/i,
];

/** Small Ollama models that can't self-organize reliably. */
const WEAK_MODEL_PATTERNS = [
  /\b(1b|2b|3b|4b|7b|8b)\b/i,
  /\bgemma.*:(?:2b|4b|7b)\b/i,
  /\bqwen.*:(?:1|2|3|4|7|8)b\b/i,
  /\bphi-?[34](?:-mini)?\b/i,
];

// ============================================================================
// DOMAIN SIGNALS
// ============================================================================

const DOMAIN_SIGNALS: Array<{ keywords: string[]; roles: string[] }> = [
  {
    keywords: ['write', 'blog', 'content', 'article', 'copy', 'draft', 'post'],
    roles: ['writer', 'content', 'editor', 'copywriter', 'blog', 'marketing'],
  },
  {
    keywords: ['research', 'analyze', 'investigate', 'data'],
    roles: ['research', 'analyst', 'data', 'intelligence'],
  },
  {
    keywords: ['lead', 'prospect', 'outreach', 'pipeline', 'sales', 'deal'],
    roles: ['sales', 'lead', 'outreach', 'sdr'],
  },
  {
    keywords: ['support', 'ticket', 'complaint', 'customer', 'help'],
    roles: ['support', 'customer', 'success'],
  },
  {
    keywords: ['metric', 'kpi', 'report', 'trend', 'growth', 'revenue'],
    roles: ['analyst', 'data', 'metrics', 'growth', 'finance'],
  },
  {
    keywords: ['plan', 'strategy', 'roadmap', 'quarter', 'goal'],
    roles: ['strategy', 'planning', 'operations'],
  },
];

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export function shouldSequence(input: ShouldSequenceInput): ShouldSequenceResult {
  const { prompt, agents, ollamaModel } = input;
  const lower = prompt.toLowerCase();

  // Gate 1: Need at least 2 agents
  if (agents.length < 2) {
    return { shouldSequence: false, reason: 'Only one agent available', relevantAgentCount: agents.length };
  }

  // Gate 2: Weak model check
  if (ollamaModel && WEAK_MODEL_PATTERNS.some((p) => p.test(ollamaModel))) {
    return { shouldSequence: false, reason: 'Local model too small for Sequential', relevantAgentCount: agents.length };
  }

  // Gate 3: Complexity scoring
  const simpleHits = SIMPLE_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  const complexHits = COMPLEX_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  const multiStepHits = MULTI_STEP_PATTERNS.filter((p) => p.test(prompt)).length;
  const wordCount = prompt.split(/\s+/).length;

  let score = 0;
  if (wordCount < 20) score -= 2;
  if (wordCount > 100) score += 1;
  score -= simpleHits;
  score += complexHits * 2;
  score += multiStepHits * 2;

  if (score < 2) {
    return { shouldSequence: false, reason: 'Task is simple enough for a single agent', relevantAgentCount: 1 };
  }

  // Gate 4: Domain matching
  const relevantAgentIds = new Set<string>();
  let matchedDomains = 0;

  for (const domain of DOMAIN_SIGNALS) {
    if (!domain.keywords.some((kw) => lower.includes(kw))) continue;
    matchedDomains++;
    for (const agent of agents) {
      if (domain.roles.some((r) => agent.role.toLowerCase().includes(r))) {
        relevantAgentIds.add(agent.id);
      }
    }
  }

  const relevantAgentCount = relevantAgentIds.size;

  if (matchedDomains >= 2 && relevantAgentCount >= 2) {
    return {
      shouldSequence: true,
      reason: `Task spans ${matchedDomains} domains with ${relevantAgentCount} relevant agents`,
      relevantAgentCount,
    };
  }

  if (score >= 4 && agents.length >= 3) {
    return {
      shouldSequence: true,
      reason: 'Complex task with 3+ agents available',
      relevantAgentCount: Math.max(relevantAgentCount, 2),
    };
  }

  return {
    shouldSequence: false,
    reason: 'Task complexity does not justify multi-agent coordination',
    relevantAgentCount,
  };
}
