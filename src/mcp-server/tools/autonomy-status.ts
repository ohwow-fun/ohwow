/**
 * Autonomy Status MCP Tools (Phase 6.7 Deliverable C).
 *
 * Two surfaces over the daemon-local autonomy stack:
 *   * `ohwow_autonomy_status` — current snapshot: flag state, open
 *     arcs, recent closed arcs, recent phase reports, inbox counts,
 *     pulse-side counts.
 *   * `ohwow_autonomy_dry_run` — what the conductor's ranker WOULD
 *     pick if it ticked right now. Read-only; never opens an arc.
 *
 * Companion to `ohwow_list_founder_inbox` — both let an operator see
 * what the autonomy is doing without reading SQLite directly. These
 * verbs are the lever a future Claude Code session needs to figure out
 * "what's happening" before deciding whether to flip the conductor flag
 * or hand-resolve a stuck inbox row.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

function jsonResponse(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

interface ConductorStatePayload {
  workspace_id: string;
  flag_on: boolean;
  open_arcs: Array<{
    arc_id: string;
    opened_at: string;
    thesis: string;
    elapsed_minutes: number;
    phases_run: number;
    phases_remaining: number;
  }>;
  recent_arcs: Array<{
    arc_id: string;
    closed_at: string;
    status: string;
    exit_reason: string;
    phases_run: number;
  }>;
  recent_phase_reports: Array<{
    phase_id: string;
    arc_id: string;
    mode: string;
    goal: string;
    status: string;
  }>;
  open_inbox_count: number;
  answered_unresolved_inbox_count: number;
  failing_triggers_count: number;
  pending_approvals_count: number;
}

interface DryRunPayload {
  workspace_id: string;
  ts: string;
  candidates: Array<{
    mode: string;
    goal: string;
    score: number;
    source: string;
    source_id?: string;
  }>;
  total_candidates: number;
  pre_seed_inbox_count: number;
}

export function registerAutonomyStatusTools(
  server: McpServer,
  client: DaemonApiClient,
): void {
  server.tool(
    'ohwow_autonomy_status',
    '[Conductor] Snapshot of the autonomy stack: dark-launch flag state, any open arc with budget + elapsed time, the last 5 closed arcs with exit reasons, the last 10 phase reports across the workspace, inbox counts (open + answered-unresolved), and pulse-side counts (failing triggers, pending approvals). Cheap reads only — no LLM calls, no writes. Use this BEFORE deciding to flip OHWOW_AUTONOMY_CONDUCTOR=1 or hand-resolve a stuck row.',
    {},
    async () => {
      try {
        const result = (await client.get('/api/autonomy/status')) as {
          data?: ConductorStatePayload;
          error?: string;
        };
        if (result.error) {
          return errorResponse(`Couldn't read autonomy status: ${result.error}`);
        }
        const snap = result.data;
        if (!snap) {
          return errorResponse('Autonomy status returned no data.');
        }
        const summaryLines: string[] = [];
        summaryLines.push(`flag=${snap.flag_on ? 'ON' : 'OFF'}`);
        summaryLines.push(`open_arcs=${snap.open_arcs.length}`);
        summaryLines.push(`open_inbox=${snap.open_inbox_count}`);
        summaryLines.push(
          `answered_unresolved=${snap.answered_unresolved_inbox_count}`,
        );
        summaryLines.push(
          `pending_approvals=${snap.pending_approvals_count}`,
        );
        summaryLines.push(
          `failing_triggers=${snap.failing_triggers_count}`,
        );

        return jsonResponse({
          ok: true,
          summary: summaryLines.join(' / '),
          state: snap,
          note:
            !snap.flag_on
              ? 'Conductor is dark-launched. Set OHWOW_AUTONOMY_CONDUCTOR=1 in the process env and restart to enable. Use ohwow_autonomy_dry_run first to see what would be picked.'
              : snap.open_arcs.length === 0
                ? 'Conductor enabled; no arc currently open.'
                : `Arc ${snap.open_arcs[0].arc_id} in flight (${snap.open_arcs[0].elapsed_minutes}m elapsed; ${snap.open_arcs[0].phases_remaining} phases left in budget).`,
        });
      } catch (err) {
        return errorResponse(
          `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    },
  );

  server.tool(
    'ohwow_autonomy_dry_run',
    '[Conductor] What the conductor\'s ranker WOULD return if it ticked right now. Reads pulse + ledger + workspace-wide answered inbox; runs the same `rankNextPhase` the conductor uses; never opens an arc. Returns the top N candidates (default 10) with their score, source, and goal. Use this to preview behavior before flipping OHWOW_AUTONOMY_CONDUCTOR=1, or to debug "why did the conductor pick X" after the fact.',
    {
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Cap the returned candidates. Default: 10. Max: 100.'),
    },
    async ({ limit }) => {
      try {
        const qs = limit !== undefined ? `?limit=${limit}` : '';
        const result = (await client.get(`/api/autonomy/dry-run${qs}`)) as {
          data?: DryRunPayload;
          error?: string;
        };
        if (result.error) {
          return errorResponse(
            `Couldn't run autonomy dry-run: ${result.error}`,
          );
        }
        const snap = result.data;
        if (!snap) {
          return errorResponse('Autonomy dry-run returned no data.');
        }
        return jsonResponse({
          ok: true,
          ts: snap.ts,
          total_candidates: snap.total_candidates,
          pre_seed_inbox_count: snap.pre_seed_inbox_count,
          candidates: snap.candidates,
          note:
            snap.candidates.length === 0
              ? 'No candidates. The conductor would open an arc that closes immediately with `nothing-queued`.'
              : `Top pick: ${snap.candidates[0].source} score=${snap.candidates[0].score} ("${snap.candidates[0].goal}").`,
        });
      } catch (err) {
        return errorResponse(
          `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    },
  );
}
