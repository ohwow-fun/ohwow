import type { ModeLens } from './types.js';

/**
 * Tooling lens — distilled from
 * `.claude/skills/be-ohwow/briefs/tooling.md`. The mcp_verbs slot is
 * intentionally empty (this mode CREATES verbs); `tables` lists the
 * registry surfaces the impl round edits.
 */
export const toolingLens: ModeLens = {
  mode: 'tooling',
  description:
    'Forge ONE missing MCP verb or helper that has tripped the orchestrator more than once or blocks the current session.',
  plan_brief_preamble: [
    'MODE: tooling. Quote the ledger line (or session tail) showing this friction tripped >=2 sessions; no speculative verbs.',
    'Write the exact MCP call you wish existed (ohwow_<verb>_<object>) and the curl equivalent against the daemon.',
    'Mirror the existing route family\'s file shape (approvals / x-drafts / permission-requests). Do not invent a new envelope.',
    'Impl: add the daemon route under src/api/routes/<domain>.ts, the MCP wrapper under src/mcp-server/tools/<domain>.ts, and the registration in tools.ts (bump the tool-count assertion).',
    'QA writes a Vitest unit + integration test, runs npm run typecheck && npm test, and notes "session reset required" in NEXT ACTION.',
  ].join('\n'),
  tables: [
    'src/mcp-server/tools.ts',
    'src/mcp-server/tools/*.ts',
    'src/api/routes/*.ts',
    'code_skills',
  ],
  mcp_verbs: [],
  experiment_families: [
    'experiment-author',
    'experiment-proposal-generator',
    'autonomous-author-quality',
    'autonomous-patch-rollback',
    'findings-gc',
    'ledger-health',
  ],
};
