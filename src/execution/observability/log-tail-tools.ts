/**
 * Typed log_tail tool.
 *
 * Wraps the `<provider> logs` CLI surfaces (supabase, vercel, fly,
 * modal) so agents don't have to compose `run_bash` invocations by
 * hand and — more importantly — so the daemon can *see* what's
 * happening in production across the providers an operator uses.
 *
 * Generic by design: target identifiers (project refs, app names,
 * modal apps) come from tool input or env vars; no caller-specific
 * defaults are baked in. If the relevant CLI or credentials are
 * missing the tool gracefully returns `{ ok: false, reason: ... }`
 * instead of throwing, so the daemon boots identically on a bare
 * clone.
 */
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

export const LOG_TAIL_SERVICES = ['supabase', 'vercel', 'fly', 'modal'] as const;
export type LogTailService = (typeof LOG_TAIL_SERVICES)[number];

export const LOG_TAIL_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'log_tail',
    description:
      "Tail recent logs from a deployed service (supabase, vercel, fly, modal) via its CLI. Returns the last N lines plus an error-density score (fraction of lines matching /error|fail|panic|fatal|exception|timeout|5\\d{2}\\b/i). Gracefully no-ops with ok=false when the CLI is missing or credentials aren't configured — never throws. Prefer this over composing `<provider> logs` through run_bash.",
    input_schema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          enum: [...LOG_TAIL_SERVICES],
          description: 'Which provider to tail from.',
        },
        target: {
          type: 'string',
          description:
            'Project/app identifier. For supabase: project ref. For vercel: project name (optional; uses linked project if omitted). For fly: app name. For modal: app name. Omit to fall back to env var defaults (OHWOW_SUPABASE_PROJECT_REF, OHWOW_VERCEL_PROJECT, OHWOW_FLY_APP, OHWOW_MODAL_APP).',
        },
        lines: {
          type: 'integer',
          description: 'Number of trailing lines to retrieve. Default 200, max 2000.',
          minimum: 1,
          maximum: 2000,
        },
      },
      required: ['service'],
    },
  },
];

export const LOG_TAIL_TOOL_NAMES = LOG_TAIL_TOOL_DEFINITIONS.map((t) => t.name);

export function isLogTailTool(toolName: string): boolean {
  return LOG_TAIL_TOOL_NAMES.includes(toolName);
}

export const LOG_TAIL_SYSTEM_PROMPT = `
## Reading Production Logs

You have a typed **log_tail** tool for pulling recent logs from the
services the operator has deployed (supabase, vercel, fly, modal).
It returns the last N lines and an error-density score. Use it when
debugging a live incident or when a task refers to something that
just happened in production. Prefer this over run_bash + provider
CLI — the tool handles arg construction, timeouts, and the "CLI
not installed / not logged in" cases without crashing the task.
`;
