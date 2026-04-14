/**
 * Self-bench Findings MCP Tool
 *
 * ohwow_list_findings exposes the self_findings ledger to MCP clients
 * (Claude Code, Cursor, etc.) so any agent session can read "what has
 * the system learned about itself" before investigating a surface
 * from scratch.
 *
 * This is the operator-visible half of Phase 1. The runner writes
 * findings; this tool reads them. Categories and verdicts match the
 * typed enums in src/self-bench/experiment-types.ts so filters are
 * stable across versions.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function jsonResponse(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

interface FindingJson {
  id: string;
  experimentId: string;
  category: string;
  subject: string | null;
  hypothesis: string | null;
  verdict: string;
  summary: string;
  evidence: Record<string, unknown>;
  interventionApplied: { description: string; details: Record<string, unknown> } | null;
  ranAt: string;
  durationMs: number;
}

export function registerFindingsTools(
  server: McpServer,
  client: DaemonApiClient,
): void {
  server.tool(
    'ohwow_list_findings',
    '[Self-bench] List rows from the self_findings ledger — the structured record of every self-experiment the daemon has run. Each row captures: experiment_id, category, subject, hypothesis, verdict (pass/warning/fail/error), summary, evidence JSON, and an optional intervention_applied blob describing what the experiment changed. Use this BEFORE investigating a surface from scratch — past findings likely already tell you what the system learned about a model, trigger, tool, or handler. Filters compose freely. Defaults to active status, newest-first, 50 rows. Examples: to see current model-picker health run with {category: "model_health"}; to see every stuck trigger find run with {category: "trigger_stability", verdict: "fail"}; to see everything a specific experiment has logged run with {experiment_id: "model-health"}.',
    {
      experiment_id: z.string().optional().describe('Filter to one experiment id (e.g. "model-health", "trigger-stability"). Returns only rows that experiment produced.'),
      category: z.enum([
        'model_health',
        'trigger_stability',
        'tool_reliability',
        'handler_audit',
        'prompt_calibration',
        'canary',
        'other',
      ]).optional().describe('Filter to one typed category. Categories match src/self-bench/experiment-types.ts.'),
      verdict: z.enum(['pass', 'warning', 'fail', 'error']).optional().describe('Filter to one verdict. Use "fail" or "error" to focus on problems; "warning" to see drift before it becomes failure.'),
      subject: z.string().optional().describe('Filter to rows about a specific subject (e.g. "qwen/qwen3.5-9b", "trigger:d1a924de..."). Lets you trace the history of a single model or trigger over time.'),
      status: z.enum(['active', 'superseded', 'revoked']).optional().describe('Row lifecycle filter. Defaults to "active" — rows that haven\'t been superseded or revoked by a later finding. Use "superseded" to see historical findings that got replaced.'),
      limit: z.number().int().positive().max(500).optional().describe('Cap on rows returned. Default 50, hard max 500.'),
    },
    async ({ experiment_id, category, verdict, subject, status, limit }) => {
      try {
        const qs = new URLSearchParams();
        if (experiment_id) qs.set('experiment_id', experiment_id);
        if (category) qs.set('category', category);
        if (verdict) qs.set('verdict', verdict);
        if (subject) qs.set('subject', subject);
        if (status) qs.set('status', status);
        if (limit !== undefined) qs.set('limit', String(limit));
        const qsStr = qs.toString() ? `?${qs.toString()}` : '';

        const result = (await client.get(`/api/findings${qsStr}`)) as {
          data?: FindingJson[];
          count?: number;
          limit?: number;
          error?: string;
        };

        if (result.error) {
          return errorResponse(`Couldn't list findings: ${result.error}`);
        }

        const findings = result.data ?? [];
        return jsonResponse({
          ok: true,
          count: findings.length,
          limit: result.limit,
          findings,
          note: findings.length === 0
            ? 'No findings match these filters. Widen the filters (drop verdict or category) or wait for the next experiment tick.'
            : `${findings.length} finding(s) returned. Each is a historical record of one experiment run — use the evidence field to see raw probe output and intervention_applied to see what changed (if anything).`,
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );
}
