/**
 * Body State Tool — Exposes system health as a queryable tool for agents.
 *
 * Returns organ health, task performance, memory pressure, pipeline status,
 * and cost trajectory. Compatible with cloud dashboard's get_body_state tool.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { BodyStateService } from '../../body/body-state.js';

/** Cached service per workspace. Keyed on both workspaceId AND the
 *  resolved DigitalBody identity so swapping a workspace (or the body)
 *  busts the cache automatically. */
let cachedService: BodyStateService | null = null;
let cachedKey: string | null = null;

export async function getBodyState(ctx: LocalToolContext): Promise<ToolResult> {
  // Pull the live DigitalBody off the brain so BodyStateService can
  // enumerate organs. Previously this was a no-op ternary that always
  // passed undefined, so the `organs` array came back empty on every call
  // even though the body had 3 organs wired up at startup. P0.3
  // proprioception bench caught it.
  const digitalBody = ctx.engine.getBrain()?.getDigitalBody() ?? undefined;
  const key = `${ctx.workspaceId}:${digitalBody ? 'body' : 'no-body'}`;

  if (!cachedService || cachedKey !== key) {
    cachedService = new BodyStateService(ctx.db, ctx.workspaceId, digitalBody);
    cachedKey = key;
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
