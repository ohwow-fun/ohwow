/**
 * investigate_shell — regex-gated read-only shell for the investigate
 * sub-orchestrator focus.
 *
 * The `run_bash` tool is intentionally EXCLUDED from the investigate
 * focus allowlist (see sub-orchestrator.getExcludedTools) because it
 * can mutate state and lets the investigator burn context on side
 * quests. But code investigation legitimately needs a shell: bisecting
 * the M0.21 timestamp-drift bug required `sqlite3 ... "SELECT ..."` to
 * inspect row-level data formats, and that's the class of capability
 * the investigator cannot be effective without.
 *
 * This tool wraps `executeBashTool` with a pre-dispatch regex gate:
 * only a fixed set of read-only command shapes pass through. Any
 * pipeline, redirect, or chain is rejected so the investigator can't
 * accidentally (or intentionally) chain into a mutation. The model
 * sees a structured error describing the allowed patterns when it
 * picks a rejected command, so a single retry usually recovers.
 *
 * Scope intentionally kept narrow: if a shape belongs in the allowlist
 * and isn't, adding it here is safer than teaching the investigator to
 * fall back to something more permissive.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { FileAccessGuard } from '../../execution/filesystem/index.js';
import { executeBashTool } from '../../execution/bash/index.js';
import { logger } from '../../lib/logger.js';

/**
 * Whitelisted command prefixes. Each regex must anchor at start-of-line
 * to prevent a sneaky `cat /etc/passwd ; rm -rf ~/` from slipping
 * through on the prefix alone. The pipeline/redirect gate runs
 * separately so these patterns do not need to defend against that
 * axis.
 */
const READ_ONLY_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  // sqlite3 with explicit SELECT or dot-command — no DML/DDL
  /^sqlite3\s+\S+\s+['"]SELECT\s/i,
  /^sqlite3\s+\S+\s+['"]WITH\s/i,
  /^sqlite3\s+\S+\s+['"]\.schema/,
  /^sqlite3\s+\S+\s+['"]\.tables/,
  /^sqlite3\s+\S+\s+['"]\.dbinfo/,
  // ripgrep / grep
  /^(rg|grep)\s+/,
  // find (allowed even though it can exec; the exec clause is blocked
  // by the mutation-char gate below)
  /^find\s+/,
  // plain read utilities
  /^(head|tail|cat|wc|ls|stat|file)\s+/,
  // structured text utilities — jq/awk/sed are read-only by default;
  // sed -i is blocked by the dedicated rule in MUTATION_CHAR_PATTERNS
  /^jq\s+/,
  /^awk\s+/,
  /^sed\s+/,
  // `node -e` and `python -c` are intentionally EXCLUDED: once the
  // interpreter is running, anything goes, and the Python/JS statement
  // separator `;` collides with the shell-chain gate either way. If an
  // investigation legitimately needs interpreted logic, it should lean
  // on jq/awk or fall back to delegating to a write-capable path with
  // explicit user approval.
];

/**
 * Shell metacharacters rejected outright — we want every invocation
 * to be a single command. Chaining, piping, redirecting, and command
 * substitution all open paths to mutations even when the head command
 * looks benign. The model is instructed in the investigate prompt to
 * run follow-up searches as separate tool calls, not shell chains.
 */
const MUTATION_CHAR_PATTERNS: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /\|/, name: 'pipeline `|`' },
  { re: /&&/, name: 'logical-and `&&`' },
  { re: /;/, name: 'command separator `;`' },
  { re: /(^|[^0-9])>(?!=)/, name: 'redirect `>`' },
  { re: /(^|[^0-9])<(?!=)/, name: 'redirect `<`' },
  { re: /\$\(/, name: 'command substitution `$(...)`' },
  { re: /`/, name: 'backtick substitution' },
  { re: /\bsed\s+(?:[^-]*\s)?-[a-zA-Z]*i\b/, name: '`sed -i` in-place edit' },
  { re: /\brm\b/, name: '`rm`' },
  { re: /\bmv\b/, name: '`mv`' },
  { re: /\bcp\b/, name: '`cp`' },
  { re: /\bchmod\b/, name: '`chmod`' },
  { re: /\bchown\b/, name: '`chown`' },
  { re: /\bsqlite3\s+\S+\s+['"](INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)/i, name: 'sqlite3 DML/DDL' },
];

export interface CommandGateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Pure validator exported for unit tests. Returns `{ allowed: true }`
 * iff the command matches at least one read-only pattern AND contains
 * no mutation characters.
 */
export function validateReadOnlyCommand(command: string): CommandGateResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: 'command is empty' };
  }
  for (const { re, name } of MUTATION_CHAR_PATTERNS) {
    if (re.test(trimmed)) {
      return {
        allowed: false,
        reason: `command rejected: ${name} not allowed in investigate_shell. Run follow-up work as separate tool calls, not a shell chain.`,
      };
    }
  }
  const matched = READ_ONLY_COMMAND_PATTERNS.some((re) => re.test(trimmed));
  if (!matched) {
    return {
      allowed: false,
      reason:
        'command rejected: investigate_shell only accepts read-only shapes. Allowed heads: ' +
        'sqlite3 <db> "SELECT ...", sqlite3 <db> ".schema ...", rg, grep, find, head, tail, cat, wc, ls, stat, file, jq, awk, sed, node -e, python -c.',
    };
  }
  return { allowed: true };
}

export const INVESTIGATE_SHELL_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'investigate_shell',
    description:
      'Read-only shell for the investigate sub-orchestrator focus. Accepts a narrow allowlist of search/read/introspection commands (sqlite3 SELECT, rg/grep, find, head/tail/cat/wc/ls, jq/awk/sed, node -e / python -c). Pipelines, redirects, and chains are rejected — run follow-up work as separate tool calls. Prefer local_search_content for plain grep and use this only when you need DB introspection or regex shapes the filesystem tools cannot express.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'A single read-only command. See description for the allowed head list.',
        },
        working_directory: {
          type: 'string',
          description: 'Optional absolute directory to execute from. Must be inside the orchestrator file access allowlist.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional hard timeout in milliseconds. Default 30000, max 180000.',
        },
      },
      required: ['command'],
    },
  },
];

/** Cached guard per workspace. Mirror of bash.ts's cache so we pick up new paths on invalidate. */
let cachedGuard: FileAccessGuard | null = null;
let cachedKey: string | null = null;

async function getGuard(ctx: LocalToolContext): Promise<FileAccessGuard | null> {
  const key = ctx.workspaceId;
  if (cachedGuard && cachedKey === key) return cachedGuard;

  const { data } = await ctx.db
    .from('agent_file_access_paths')
    .select('path')
    .eq('agent_id', '__orchestrator__')
    .eq('workspace_id', ctx.workspaceId);

  const paths = data ? (data as Array<{ path: string }>).map((p) => p.path) : [];
  if (paths.length === 0) return null;

  cachedGuard = new FileAccessGuard(paths);
  cachedKey = key;
  return cachedGuard;
}

/** Invalidate the investigate_shell guard cache. Used by the same path-update events that reset bash.ts's cache. */
export function invalidateInvestigateShellAccessCache(): void {
  cachedGuard = null;
  cachedKey = null;
}

export async function investigateShell(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const command = (input.command as string | undefined)?.trim() ?? '';
  const gate = validateReadOnlyCommand(command);
  if (!gate.allowed) {
    logger.warn({ command, reason: gate.reason }, '[investigate_shell] command rejected');
    return { success: false, error: gate.reason ?? 'command rejected' };
  }

  const guard = await getGuard(ctx);
  if (!guard) {
    return {
      success: false,
      error: 'No directories are configured for file access. The orchestrator needs an allowlist before investigate_shell can run.',
    };
  }

  // Clamp the caller-supplied timeout to [1000, 180000]. The underlying
  // executor enforces its own max but we pin the investigator to a
  // tighter ceiling — a 5 min shell call during a 6 min investigation
  // burns most of the budget on one step.
  const rawTimeout = typeof input.timeout_ms === 'number' ? (input.timeout_ms as number) : 30_000;
  const timeoutMs = Math.max(1000, Math.min(180_000, Math.floor(rawTimeout)));

  try {
    const result = await executeBashTool(
      guard,
      'run_bash',
      { command, working_directory: input.working_directory, timeout_ms: timeoutMs },
      { gitEnabled: false },
    );
    if (result.is_error) {
      if (result.content.includes('outside allowed paths')) {
        const requestedPath = input.working_directory as string | undefined;
        return { success: false, error: result.content, needsPermission: requestedPath || '' };
      }
      return { success: false, error: result.content };
    }
    return { success: true, data: result.content };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'investigate_shell failed',
    };
  }
}
