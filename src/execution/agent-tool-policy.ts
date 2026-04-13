/**
 * Agent Tool Policy Resolver
 *
 * Single choke point that translates an agent's persisted `config` into the
 * effective tool surface the engine should build. Resolves the allowlist from
 * its canonical field (`tools_enabled` + `tools_mode`), falls back to the
 * legacy `allowed_tools`/`blocked_tools` fields, and reports which MCP server
 * names the allowlist implicitly references so the engine can auto-load them.
 *
 * Why this lives as its own module
 * --------------------------------
 * The engine historically read `config.allowed_tools`, while the API write
 * path and the typed MCP management tools write `config.tools_enabled` plus
 * `config.tools_mode === 'allowlist'`. Those two field namespaces never met,
 * so an allowlist created via `ohwow_create_agent` was silently ignored at
 * run time and the agent saw the default tool surface. Worse, the default
 * surface includes `web_search`, `request_browser`, and a couple of other
 * feature-flagged tools that leaked past the supposed allowlist.
 *
 * This module centralizes the decision so the engine can ask three simple
 * questions: (1) are we in allowlist mode, (2) which MCP servers must be
 * loaded for it to work, (3) is this tool name allowed. Tests in the
 * sibling `__tests__/agent-tool-policy.test.ts` lock the behavior.
 */

import { isMcpTool, parseMcpToolName } from '../mcp/tool-adapter.js';

export type AgentToolMode = 'allowlist' | 'inherit';

export interface ResolvedAgentToolPolicy {
  /**
   * When "allowlist": only names in `allowedNames` reach the model. All
   * feature-flag defaults (web search, browser, scrapling, filesystem,
   * bash, MCP) are ignored — the list is exclusive.
   *
   * When "inherit": the legacy behavior stands. Feature flags expand the
   * surface and `allowedNames`, if populated, acts as a narrow filter on
   * top. `blockedNames` removes entries from whatever remains.
   */
  mode: AgentToolMode;
  /** Names the allowlist explicitly permits. Empty => nothing allowed. */
  allowedNames: ReadonlySet<string>;
  /** Names the legacy blocklist rejects. Only consulted in "inherit" mode. */
  blockedNames: ReadonlySet<string>;
  /**
   * MCP server names referenced by `mcp__<server>__<tool>` entries in the
   * allowlist. The engine uses this to decide which servers to connect
   * even when the agent does not set `mcp_enabled` — the act of adding
   * an `mcp__` entry to the allowlist is itself the enable signal.
   */
  referencedMcpServers: ReadonlySet<string>;
  /** True when any MCP-shaped entry is in the allowlist. */
  requiresMcp: boolean;
}

/**
 * Resolve the tool policy for an agent from its (already-parsed) config blob.
 * Safe on any shape: undefined, empty object, legacy fields, modern fields.
 */
export function resolveAgentToolPolicy(agentConfig: unknown): ResolvedAgentToolPolicy {
  const cfg = (agentConfig ?? {}) as Record<string, unknown>;

  // Canonical fields written by the API create route and the MCP typed tools.
  const toolsEnabled = Array.isArray(cfg.tools_enabled)
    ? (cfg.tools_enabled as unknown[]).filter((n): n is string => typeof n === 'string')
    : undefined;
  const toolsMode = typeof cfg.tools_mode === 'string' ? cfg.tools_mode : undefined;

  // Legacy fields the engine historically read. Keep them working so
  // agents created before this unification still resolve correctly.
  const legacyAllowed = Array.isArray(cfg.allowed_tools)
    ? (cfg.allowed_tools as unknown[]).filter((n): n is string => typeof n === 'string')
    : undefined;
  const legacyBlocked = Array.isArray(cfg.blocked_tools)
    ? (cfg.blocked_tools as unknown[]).filter((n): n is string => typeof n === 'string')
    : undefined;

  // Decide mode. "allowlist" wins whenever it is explicit OR when the
  // caller populated `tools_enabled` without setting a mode — that was
  // the documented behavior of the API create route.
  let mode: AgentToolMode = 'inherit';
  if (toolsMode === 'allowlist') {
    mode = 'allowlist';
  } else if (toolsEnabled && toolsEnabled.length > 0 && toolsMode !== 'inherit') {
    // Caller populated the list but did not spell out a mode. Treat it
    // as allowlist since that matches how the MCP create tool frames it.
    mode = 'allowlist';
  }

  // Collect allowed names. Prefer canonical, fall back to legacy.
  const allowed = new Set<string>();
  if (toolsEnabled && toolsEnabled.length > 0) {
    for (const n of toolsEnabled) allowed.add(n);
  } else if (legacyAllowed) {
    for (const n of legacyAllowed) allowed.add(n);
  }

  const blocked = new Set<string>(legacyBlocked ?? []);

  // Identify MCP servers referenced by the allowlist. Parsing is defensive:
  // malformed entries are skipped rather than throwing, because the API
  // validator already rejects those at write time.
  const mcpServers = new Set<string>();
  for (const name of allowed) {
    if (!isMcpTool(name)) continue;
    const parsed = parseMcpToolName(name);
    if (parsed) mcpServers.add(parsed.serverName);
  }

  return {
    mode,
    allowedNames: allowed,
    blockedNames: blocked,
    referencedMcpServers: mcpServers,
    requiresMcp: mcpServers.size > 0,
  };
}

/**
 * Filter a tool definition list down to what the agent's policy allows.
 * Accepts any object with an optional `name` field — covers both the
 * client-side Tool shape and the Anthropic-specific WebSearchTool20250305
 * (which has a `name` too). Unnamed entries pass through unchanged so the
 * caller can keep server-side tool shapes that do not carry a name.
 *
 * - allowlist mode: only tools whose names are in `allowedNames` survive.
 *   Unnamed entries are dropped — if you cannot identify it, you cannot
 *   reason about whether it should be in a strict allowlist.
 * - inherit mode: allowlist (if non-empty) narrows; blocklist removes.
 *   Unnamed entries pass through either way.
 */
export function filterToolsByPolicy<T extends { name?: string }>(
  tools: T[],
  policy: ResolvedAgentToolPolicy,
): T[] {
  if (policy.mode === 'allowlist') {
    return tools.filter((t) => {
      if (typeof t.name !== 'string') return false;
      return policy.allowedNames.has(t.name);
    });
  }

  // inherit mode
  let out = tools;
  if (policy.allowedNames.size > 0) {
    out = out.filter((t) => typeof t.name !== 'string' || policy.allowedNames.has(t.name));
  }
  if (policy.blockedNames.size > 0) {
    out = out.filter((t) => typeof t.name !== 'string' || !policy.blockedNames.has(t.name));
  }
  return out;
}

/**
 * True when the policy permits the named feature-flag tool to participate
 * in the surface. In allowlist mode that means the name is explicitly
 * listed; in inherit mode the feature flag's own boolean wins.
 *
 * Used by the engine to avoid pushing `web_search`, `request_browser`,
 * etc. when the operator built a narrow read-only allowlist that never
 * mentioned them. Without this gate the defaults leak past the allowlist.
 */
export function allowlistPermits(
  policy: ResolvedAgentToolPolicy,
  toolName: string,
): boolean {
  if (policy.mode !== 'allowlist') return true;
  return policy.allowedNames.has(toolName);
}
