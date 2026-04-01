/**
 * Body State Tool — Exposes system health as a queryable tool for agents.
 *
 * Returns organ health, task performance, memory pressure, pipeline status,
 * and cost trajectory. Compatible with cloud dashboard's get_body_state tool.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { BodyStateService } from '../../body/body-state.js';

/** Cached service instance per workspace (avoid re-creating on each call) */
let cachedService: BodyStateService | null = null;
let cachedWorkspaceId = '';

export async function getBodyState(ctx: LocalToolContext): Promise<ToolResult> {
  if (!cachedService || cachedWorkspaceId !== ctx.workspaceId) {
    const digitalBody = ctx.engine.getBrain()?.getProprioception()
      ? undefined // Body is wired via brain, we'll reconstruct
      : undefined;
    cachedService = new BodyStateService(ctx.db, ctx.workspaceId, digitalBody);
    cachedWorkspaceId = ctx.workspaceId;
  }

  try {
    const state = await cachedService.getBodyState();
    return { success: true, data: state };
  } catch (err) {
    return {
      success: false,
      error: `Couldn't retrieve body state: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}
