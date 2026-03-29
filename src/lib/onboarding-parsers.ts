/**
 * Onboarding Parsers
 * Pure string-parsing functions for onboarding responses.
 * Safe for browser (Vite web build) — no Node.js dependencies.
 *
 * Extracted from onboarding-logic.ts so the web bundle doesn't pull in
 * AutomationService, MCP catalog, or other server-only modules.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  goal: { title: string; metric?: string; target?: number; unit?: string } | null;
  agentIds: string[];
}

// ── Parsers ──────────────────────────────────────────────────────────────────

/** Parse agent IDs from the model's response. */
export function parseAgentRecommendations(response: string): string[] {
  // Look for ```agents block
  const agentBlockMatch = response.match(/```agents\s*\n?([\s\S]*?)```/);
  if (agentBlockMatch) {
    try {
      const parsed = JSON.parse(agentBlockMatch[1].trim());
      if (Array.isArray(parsed)) return parsed.filter(id => typeof id === 'string');
    } catch {
      // Fall through to regex
    }
  }

  // Fallback: look for JSON array in the text
  const arrayMatch = response.match(/\[[\s\S]*?\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed.filter(id => typeof id === 'string');
    } catch {
      // No valid JSON
    }
  }

  return [];
}

/** Parse a ```setup JSON block from the model's response. Falls back to parseAgentRecommendations(). */
export function parseDiscoveryResult(response: string): DiscoveryResult {
  // Try to parse ```setup JSON block
  const setupBlockMatch = response.match(/```setup\s*\n?([\s\S]*?)```/);
  if (setupBlockMatch) {
    try {
      const parsed = JSON.parse(setupBlockMatch[1].trim()) as {
        goal?: string;
        goal_metric?: string;
        goal_target?: number;
        unit?: string;
        agents?: string[];
      };

      const goal = parsed.goal
        ? {
            title: parsed.goal,
            metric: parsed.goal_metric || undefined,
            target: parsed.goal_target != null ? parsed.goal_target : undefined,
            unit: parsed.unit || undefined,
          }
        : null;

      const agentIds = Array.isArray(parsed.agents)
        ? parsed.agents.filter((id): id is string => typeof id === 'string')
        : [];

      return { goal, agentIds };
    } catch {
      // Fall through to legacy parsing
    }
  }

  // Fall back to parseAgentRecommendations() for backward compat
  const agentIds = parseAgentRecommendations(response);
  return { goal: null, agentIds };
}
