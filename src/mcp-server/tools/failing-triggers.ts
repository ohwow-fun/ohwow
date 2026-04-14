/**
 * Failing Triggers MCP Tool
 *
 * Companion to ohwow_list_permission_requests — both surface "things
 * that are stuck and need operator attention." This one is specifically
 * for the scheduled/trigger-originated class of failure: triggers
 * whose tasks have been failing consecutively for the watchdog
 * threshold or more, so the operator can notice silent cron breakage
 * without reading individual task outputs.
 *
 * Returns rows already sorted with the worst offenders first. Threshold
 * is optional; defaults to the daemon's configured TRIGGER_STUCK_THRESHOLD.
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

interface FailingTriggerRow {
  id: string;
  name: string;
  consecutive_failures: number;
  last_succeeded_at: string | null;
  last_fired_at: string | null;
  trigger_type: string | null;
  enabled: boolean;
  last_error: string | null;
}

export function registerFailingTriggersTools(
  server: McpServer,
  client: DaemonApiClient,
): void {
  server.tool(
    'ohwow_list_failing_triggers',
    '[Triggers] List every scheduled/event trigger that has been silently miscarrying. A trigger shows up here when its last N consecutive fires all failed (or landed in needs_approval without resolution) — the watchdog catches the class of "the daily diary cron has been broken for 2 weeks and nobody noticed." Returns the trigger id, name, consecutive_failures count, last_succeeded_at (or null if it has never succeeded since the watchdog was added), last_fired_at, trigger_type, enabled flag, and last_error string. Sorted worst-first. The threshold defaults to 3 but can be overridden via `threshold` to see near-misses too (e.g. `threshold: 1` returns every trigger with any failure at all).',
    {
      threshold: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Minimum consecutive_failures to include in the list. Default: 3 (matches the daemon\'s TRIGGER_STUCK_THRESHOLD). Set to 1 to see every trigger with any failure on its most recent run.'),
    },
    async ({ threshold }) => {
      try {
        const qs = threshold !== undefined ? `?threshold=${threshold}` : '';
        const result = (await client.get(`/api/failing-triggers${qs}`)) as {
          data?: FailingTriggerRow[];
          threshold?: number;
          error?: string;
        };
        if (result.error) {
          return errorResponse(`Couldn't list failing triggers: ${result.error}`);
        }
        const triggers = result.data ?? [];
        return jsonResponse({
          ok: true,
          threshold: result.threshold,
          count: triggers.length,
          triggers,
          note: triggers.length === 0
            ? `No triggers are at or above ${result.threshold} consecutive failures. Scheduled automations are running cleanly right now.`
            : `${triggers.length} trigger(s) have been failing ${result.threshold}+ runs in a row. Investigate via ohwow_get_task on recent tasks for each, or disable the trigger via the UI if it's a known-broken integration.`,
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );
}
