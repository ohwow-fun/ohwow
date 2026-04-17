/**
 * verify-strategist-lift-demote — one-shot end-to-end verification that
 * the strategist's Phase 5c lift-health branch actually demotes
 * patch-author given the seeded regression state in lift_measurements.
 *
 * Bypasses the running daemon (which may be an older binary that
 * predates Phase 5c). Reads summarizeRecentVerdicts directly for the
 * active workspace's 7d window, feeds the counts into decideStrategy
 * with otherwise-empty facts, and asserts patch-author shows up in
 * demoted_experiments with the expected reason.
 */

import { initDatabase } from '../src/db/init.js';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { loadConfig, resolveActiveWorkspace } from '../src/config.js';
import { summarizeRecentVerdicts } from '../src/self-bench/lift-measurements-store.js';
import { decideStrategy } from '../src/self-bench/experiments/strategist.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const rawDb = initDatabase(config.dbPath);
  const db = createSqliteAdapter(rawDb);

  const wsRow = rawDb
    .prepare('SELECT id FROM agent_workforce_workspaces LIMIT 1')
    .get() as { id: string } | undefined;
  if (!wsRow?.id) {
    console.error('no workspace row found.');
    process.exit(1);
  }
  const workspaceId = wsRow.id;
  const windowHours = 7 * 24;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const counts = await summarizeRecentVerdicts(db, workspaceId, since);
  const liftHealth = { ...counts, window_hours: windowHours };
  console.log(`[verify] workspace=${resolveActiveWorkspace().name} id=${workspaceId}`);
  console.log(`[verify] 7d lift_health=${JSON.stringify(liftHealth)}`);
  const netRatio =
    liftHealth.total_closed > 0
      ? (liftHealth.moved_right - liftHealth.moved_wrong) / liftHealth.total_closed
      : 0;
  console.log(`[verify] net_signed_ratio=${netRatio.toFixed(3)} (threshold: <= -0.2 with >= 5 samples)`);

  // Feed into decideStrategy with empty facts — isolates the lift branch.
  const decision = decideStrategy({
    topFailing: [],
    patchLoop: null,
    burn: null,
    liftHealth,
    reflectionCount: 0,
  });

  console.log(`[verify] decision.demoted_experiments=${JSON.stringify(decision.demoted_experiments)}`);
  console.log(`[verify] decision.priority_experiments=${JSON.stringify(decision.priority_experiments)}`);
  console.log(`[verify] decision.active_focus=${JSON.stringify(decision.active_focus)}`);

  const demoted = decision.demoted_experiments.includes('patch-author');
  const focusMentionsLift = decision.active_focus.includes('lift regression');
  if (liftHealth.total_closed >= 5 && netRatio <= -0.2) {
    if (demoted && focusMentionsLift) {
      console.log('[verify] ✅ PASS — strategist would demote patch-author with lift-regression reason.');
      process.exit(0);
    }
    console.error('[verify] ❌ FAIL — threshold tripped but demote did not fire.');
    process.exit(2);
  }
  console.log(
    `[verify] threshold not tripped (samples=${liftHealth.total_closed}, ratio=${netRatio.toFixed(3)}); strategist stays neutral. Run seeder with --mode regression first.`,
  );
}

void main().then(
  () => { /* exit handled inline */ },
  (err) => {
    console.error('[verify] fatal:', err);
    process.exit(1);
  },
);
