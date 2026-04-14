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

    // Decorate with the BPP affective vitals so chat agents can introspect
    // their own emotional + physiological state in the same call. The data
    // is otherwise only exposed by the public /health endpoint, which
    // means the orchestrator could not answer "how do you feel" through
    // any tool — proprioception bench P4.14 caught it.
    const brain = ctx.engine.getBrain();
    const bpp: Record<string, unknown> = {};
    if (brain) {
      try {
        const affect = brain.getAffectEngine?.()?.getState();
        if (affect) {
          bpp.affect_dominant = affect.dominant;
          bpp.affect_valence = affect.valence;
          bpp.affect_arousal = affect.arousal;
        }
      } catch { /* affect engine not wired or in init */ }
      try {
        const endocrine = brain.getEndocrineSystem?.()?.getProfile();
        if (endocrine) bpp.endocrine_tone = endocrine.overallTone;
      } catch { /* endocrine not wired */ }
      try {
        const homeo = brain.getHomeostasisController?.()?.getOverallDeviation();
        if (typeof homeo === 'number') bpp.homeostasis_deviation = homeo;
      } catch { /* homeo not wired */ }
      try {
        const sleep = brain.getSleepCycle?.()?.getState();
        if (sleep) {
          bpp.sleep_phase = sleep.phase;
          bpp.sleep_debt = sleep.sleepDebt;
        }
      } catch { /* sleep cycle not wired */ }
    }

    return {
      success: true,
      data: Object.keys(bpp).length > 0 ? { ...state, bpp } : state,
    };
  } catch (err) {
    return {
      success: false,
      error: `Couldn't retrieve body state: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}
