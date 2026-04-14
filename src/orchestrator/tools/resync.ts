/**
 * resync_workspace_to_cloud — maintenance tool that walks every
 * synced table in the workspace and re-fires reportResource for each
 * row. Exists for two scenarios:
 *
 *   1. A workspace that ran locally for a while before joining cloud,
 *      so its existing tasks/goals/plans/team_members never went
 *      through the per-write sync hook.
 *   2. A new resource type was added to the registry, and rows
 *      created before that type existed need a one-time backfill.
 *
 * Idempotent — the cloud sync-resource endpoint upserts on conflict
 * by id. Safe to re-run any time.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { resyncWorkspaceToCloud } from '../../control-plane/sync-resources.js';

/**
 * Schema for resync_workspace_to_cloud. Previously registered as a
 * handler in tools/registry.ts but missing from the tool definitions,
 * so the model could never call it even when a resync was needed.
 * Surfaces the maintenance tool explicitly with a clear warning about
 * when it is appropriate to run.
 */
export const RESYNC_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'resync_workspace_to_cloud',
    description:
      'Maintenance tool: walk every synced table in the workspace and re-fire reportResource for each row against the cloud control plane. Idempotent (upsert on conflict), but expensive — only call when the user is intentionally backfilling a workspace that predates cloud sync, or after a new resource type was added to the registry. Always confirm before running.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

export async function resyncWorkspaceToCloudTool(
  ctx: LocalToolContext,
  _input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.controlPlane) {
    return {
      success: false,
      error: 'Cloud control plane is not connected. Connect first, then re-run.',
    };
  }
  const counts = await resyncWorkspaceToCloud(ctx);
  const total = Object.values(counts).reduce((acc, c) => acc + c.attempted, 0);
  return {
    success: true,
    data: {
      message: `Resync complete. ${total} rows pushed across ${Object.keys(counts).length} resource types.`,
      counts,
    },
  };
}
