/**
 * Mid-arc hook registry — eval-only seam.
 *
 * The Director re-reads pulse on every iteration of `runArc`; some
 * scenarios (notably the pulse-regression abort case) need to MUTATE
 * the DB between phase iterations so the next pulse read sees the
 * regressed state. The production conductor never grows that seam —
 * pulse mutations come from external producers (homeostasis,
 * business_vitals collectors). So the harness exposes a tiny
 * scenario-keyed hook registry: scenarios that need mid-arc mutation
 * register here, and the harness's deterministic `runArc` mirror
 * invokes the hook (when registered for the running scenario name)
 * after each phase completes, before the next picker call.
 */
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export interface MidArcHookContext {
  workspace_id: string;
  now: () => Date;
}

export type MidArcHook = (
  db: DatabaseAdapter,
  ctx: MidArcHookContext,
) => Promise<void>;

const HOOKS = new Map<string, MidArcHook | undefined>();

export function setMidArcHook(
  scenarioName: string,
  hook: MidArcHook | undefined,
): void {
  HOOKS.set(scenarioName, hook);
}

export function getMidArcHook(
  scenarioName: string,
): MidArcHook | undefined {
  return HOOKS.get(scenarioName);
}
