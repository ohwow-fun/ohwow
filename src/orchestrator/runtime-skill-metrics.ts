/**
 * Runtime Skill Metrics — success / failure counters + usage-aware
 * promotion for synthesized code skills.
 *
 * Every time the tool-executor dispatches a runtime skill through the
 * runtimeToolRegistry fallback path, it calls `recordRuntimeSkillOutcome`
 * with the result. This module is the single place that:
 *
 *   - Increments `success_count` or `fail_count` on the backing
 *     agent_workforce_skills row.
 *   - Syncs the updated row to the cloud via the `code_skill` resource
 *     type — the cloud dashboard needs to see live usage stats so
 *     it can show which synthesized tools are earning their keep.
 *   - Leaves `promoted_at` alone. Promotion is still the exclusive
 *     province of the synthesis tester (M6); this module only tracks
 *     ongoing outcomes. Keeping the two responsibilities separate
 *     prevents the classic "three successful dry runs in a row quietly
 *     promoted a broken tool" failure mode.
 *
 * Everything is fire-and-forget. A metric sync failure must never
 * interrupt the user's tool call, so the helper swallows errors and
 * logs at warn level.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { LocalToolContext } from './local-tool-types.js';
import { logger } from '../lib/logger.js';
import { syncResource } from '../control-plane/sync-resources.js';

export type RuntimeSkillOutcome = 'success' | 'failure';

interface SkillCountersRow {
  id?: string;
  success_count?: number | null;
  fail_count?: number | null;
  name?: string | null;
  promoted_at?: string | null;
}

async function readCounters(
  db: DatabaseAdapter,
  skillId: string,
): Promise<{ successCount: number; failCount: number; name: string | null; promotedAt: string | null }> {
  try {
    const result = await db
      .from<SkillCountersRow>('agent_workforce_skills')
      .select('id, success_count, fail_count, name, promoted_at')
      .eq('id', skillId)
      .maybeSingle();
    const row = (result.data ?? null) as SkillCountersRow | null;
    return {
      successCount: Number(row?.success_count ?? 0),
      failCount: Number(row?.fail_count ?? 0),
      name: row?.name ?? null,
      promotedAt: row?.promoted_at ?? null,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, skillId },
      '[runtime-skill-metrics] failed to read counters',
    );
    return { successCount: 0, failCount: 0, name: null, promotedAt: null };
  }
}

/**
 * Bump success_count or fail_count on the backing skill row and
 * mirror the new row state to the cloud via the code_skill
 * sync-resource channel. Never throws.
 */
export async function recordRuntimeSkillOutcome(
  ctx: LocalToolContext,
  skillId: string,
  outcome: RuntimeSkillOutcome,
): Promise<void> {
  const current = await readCounters(ctx.db, skillId);
  const nextSuccess = outcome === 'success' ? current.successCount + 1 : current.successCount;
  const nextFail = outcome === 'failure' ? current.failCount + 1 : current.failCount;
  const now = new Date().toISOString();

  try {
    await ctx.db
      .from('agent_workforce_skills')
      .update({
        success_count: nextSuccess,
        fail_count: nextFail,
        last_used_at: now,
        updated_at: now,
      })
      .eq('id', skillId);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, skillId },
      '[runtime-skill-metrics] counter update failed',
    );
    return;
  }

  // Mirror to cloud as a code_skill upsert so the dashboard's
  // synthesized-tools view reflects the new counts. Fire-and-forget.
  try {
    await syncResource(ctx, 'code_skill', 'upsert', {
      id: skillId,
      success_count: nextSuccess,
      fail_count: nextFail,
      last_used_at: now,
      name: current.name,
      promoted_at: current.promotedAt,
    });
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, skillId },
      '[runtime-skill-metrics] cloud sync threw',
    );
  }
}
