/**
 * scripts/autonomy-eval.ts — run the autonomy evaluation harness.
 *
 * Usage:
 *   tsx scripts/autonomy-eval.ts                     # diff deterministic goldens
 *   tsx scripts/autonomy-eval.ts --update            # rewrite goldens
 *   OHWOW_AUTONOMY_EVAL_UPDATE=1 tsx scripts/autonomy-eval.ts   # same
 *
 * Real-LLM (Phase 6.9) — costs real money, double-opt-in required:
 *   OHWOW_AUTONOMY_EVAL_REAL=1 tsx scripts/autonomy-eval.ts --real
 *   OHWOW_AUTONOMY_EVAL_REAL=1 tsx scripts/autonomy-eval.ts --real-only
 *
 * Exits 0 on all-pass, 1 on any failure or assertion drift.
 */

import { runAllScenarios } from '../src/autonomy/eval/harness.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const update =
    argv.includes('--update') ||
    process.env.OHWOW_AUTONOMY_EVAL_UPDATE === '1';
  const real = argv.includes('--real') || argv.includes('--real-only');
  const realOnly = argv.includes('--real-only');

  if (real && process.env.OHWOW_AUTONOMY_EVAL_REAL !== '1') {
    // eslint-disable-next-line no-console
    console.error(
      '--real requires OHWOW_AUTONOMY_EVAL_REAL=1 to be set in the environment.\n' +
        'Example: OHWOW_AUTONOMY_EVAL_REAL=1 npx tsx scripts/autonomy-eval.ts --real',
    );
    process.exit(2);
  }

  // eslint-disable-next-line no-console
  console.log(`ohwow autonomy eval - ${new Date().toISOString()}`);

  if (realOnly) {
    // eslint-disable-next-line no-console
    console.log(
      'Real-LLM only mode: skipping deterministic scenarios. Capped at $0.10 per scenario.',
    );
  } else if (real) {
    // eslint-disable-next-line no-console
    console.log(
      'Real-LLM mode: deterministic suite first, then LLM scenarios. Capped at $0.10 per scenario.',
    );
  }

  const result = await runAllScenarios({
    update,
    real,
    skip_deterministic: realOnly,
  });

  if (!realOnly) {
    for (const name of result.pass) {
      // LLM scenarios are logged inline by the LLM runner; only list
      // deterministic pass names here to avoid duplicates.
      if (name.endsWith('-real') || name.endsWith('-real-only')) continue;
      // eslint-disable-next-line no-console
      console.log(`[OK] ${name}`);
    }
    for (const name of result.updated ?? []) {
      if (!result.pass.includes(name)) continue;
      // eslint-disable-next-line no-console
      console.log(`[UPD] ${name}  (golden written)`);
    }
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
