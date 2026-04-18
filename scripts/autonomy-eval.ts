/**
 * scripts/autonomy-eval.ts — run the autonomy evaluation harness.
 *
 * Usage:
 *   tsx scripts/autonomy-eval.ts              # diff against goldens
 *   tsx scripts/autonomy-eval.ts --update     # rewrite goldens
 *   OHWOW_AUTONOMY_EVAL_UPDATE=1 tsx scripts/autonomy-eval.ts   # same
 *
 * Exits 0 on all-pass, 1 on any failure or assertion drift.
 */

import { runAllScenarios } from '../src/autonomy/eval/harness.js';

async function main(): Promise<void> {
  const update =
    process.argv.includes('--update') ||
    process.env.OHWOW_AUTONOMY_EVAL_UPDATE === '1';

  // eslint-disable-next-line no-console
  console.log(`ohwow autonomy eval — ${new Date().toISOString()}`);

  const result = await runAllScenarios({ update });

  for (const name of result.pass) {
    // eslint-disable-next-line no-console
    console.log(`[OK] ${name}`);
  }
  for (const name of result.updated ?? []) {
    if (!result.pass.includes(name)) continue;
    // eslint-disable-next-line no-console
    console.log(`[UPD] ${name}  (golden written)`);
  }
  for (const f of result.fail) {
    // eslint-disable-next-line no-console
    console.error(`[FAIL] ${f.name}: ${f.reason}`);
    if (f.diff) {
      // eslint-disable-next-line no-console
      console.error(f.diff);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `SUMMARY: ${result.pass.length} ok, ${result.fail.length} fail, ${result.updated?.length ?? 0} updated (${result.duration_ms}ms)`,
  );

  if (result.fail.length > 0) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
