#!/usr/bin/env node
/**
 * Runs experiments E1–E4 against the synthetic labeled corpus. Each
 * experiment is a named sweep of a single rubric knob; the runner
 * writes a JSON report per experiment and a consolidated summary.
 *
 * Usage: node scripts/x-experiments/_run-experiments.mjs [E1|E2|E3|E4|all]
 *
 * Outputs: /tmp/rubric-exp-<name>.json per experiment, and a combined
 * /tmp/rubric-exp-summary.json.
 */
import fs from 'node:fs';
import { loadFixture, scoreRubric, recallForTruth, withOverride, defaultRubric } from './_tune-rubric.mjs';

const rows = loadFixture();

function sweep(name, hypothesis, prediction, variants) {
  const base = defaultRubric();
  const results = variants.map(({ label, override, note }) => {
    const rubric = withOverride(base, override);
    const r = scoreRubric(rubric, rows);
    return {
      label,
      note: note || null,
      precision: r.precision,
      recall: r.recall,
      f1: r.f1,
      tp: r.tp, fp: r.fp, fn: r.fn, tn: r.tn,
      buyerRecall: recallForTruth(rubric, rows, 'buyer'),
      engagerRecall: recallForTruth(rubric, rows, 'engager'),
      noiseRecall: recallForTruth(rubric, rows, 'noise'),
      builderRecall: recallForTruth(rubric, rows, 'builder'),
    };
  });
  return { name, hypothesis, prediction, variants: results };
}

// E1 — minScore sweep
const E1 = sweep(
  'E1-score-threshold',
  'minScore=0.6 is tuned; below 0.55 precision drops, above 0.7 recall drops.',
  'knee near 0.60–0.65; noise-recall stays 0 above ~0.50.',
  [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75].map(s => ({
    label: `minScore=${s}`,
    override: { freeGates: { minScore: s } },
  })),
);

// E2 — engager boost aggressiveness
const E2 = sweep(
  'E2-engager-boost',
  'Engager boost catches replies on own posts without letting noise in.',
  'Engager recall jumps from near-baseline to >80% as boost reduces below baseline minScore.',
  [
    { label: 'no-boost', override: { freeGates: { engagerBoost: { ownPostReplyReducesMinScoreTo: 1 } } } },
    { label: 'boost-0.5', override: { freeGates: { engagerBoost: { ownPostReplyReducesMinScoreTo: 0.5 } } } },
    { label: 'boost-0.4', override: { freeGates: { engagerBoost: { ownPostReplyReducesMinScoreTo: 0.4 } } } },
    { label: 'boost-0.3', override: { freeGates: { engagerBoost: { ownPostReplyReducesMinScoreTo: 0.3 } } } },
    { label: 'boost-0.2', override: { freeGates: { engagerBoost: { ownPostReplyReducesMinScoreTo: 0.2 } } } },
  ],
);

// E3 — bucket allowlist
const E3 = sweep(
  'E3-bucket-allowlist',
  'Adding "hacks" bucket improves recall without hurting precision.',
  'Current corpus has no "hacks" bucket rows; expansion is a no-op. Documenting for next iteration.',
  [
    { label: 'ms+comp', override: { freeGates: { allowedBuckets: ['market_signal', 'competitors'] } } },
    { label: 'ms+comp+hacks', override: { freeGates: { allowedBuckets: ['market_signal', 'competitors', 'hacks'] } } },
    { label: 'ms-only', override: { freeGates: { allowedBuckets: ['market_signal'] } } },
    { label: 'comp-only', override: { freeGates: { allowedBuckets: ['competitors'] } } },
  ],
);

// E4 — touches gate
// Simulate ledger state at day-1, day-3, day-7 by inflating touches on
// the repeat-fraction of buyers (buyers stick around; noise does not).
function simulateTouches(rows, day) {
  // day=1 → everyone touches=1 (baseline fixture)
  // day=3 → buyers + engagers +1 touch, noise/builder unchanged
  // day=7 → buyers +2, engagers +1, noise/builder unchanged
  return rows.map(r => {
    let t = r.touches ?? 1;
    if (day >= 3 && (r.__truth === 'buyer' || r.__truth === 'engager')) t++;
    if (day >= 7 && r.__truth === 'buyer') t++;
    return { ...r, touches: t };
  });
}

function sweepTouches() {
  const base = defaultRubric();
  const results = [];
  for (const day of [1, 3, 7]) {
    for (const minTouches of [1, 2, 3]) {
      const rubric = withOverride(base, { freeGates: { minTouches } });
      const sim = simulateTouches(rows, day);
      const r = scoreRubric(rubric, sim);
      results.push({
        label: `day=${day} minTouches=${minTouches}`,
        precision: r.precision,
        recall: r.recall,
        f1: r.f1,
        tp: r.tp, fp: r.fp, fn: r.fn, tn: r.tn,
        buyerRecall: recallForTruth(rubric, sim, 'buyer'),
        engagerRecall: recallForTruth(rubric, sim, 'engager'),
      });
    }
  }
  return {
    name: 'E4-touches',
    hypothesis: 'minTouches=2 drops false positives once ledger accumulates repeats.',
    prediction: 'minTouches=2 wins over 1 by day 3-7 when buyers accumulate touches.',
    variants: results,
  };
}
const E4 = sweepTouches();

const which = process.argv[2] || 'all';
const all = { E1, E2, E3, E4 };
const chosen = which === 'all' ? Object.values(all) : [all[which]].filter(Boolean);
if (!chosen.length) { console.error(`unknown experiment: ${which}`); process.exit(1); }

for (const exp of chosen) {
  const path = `/tmp/rubric-exp-${exp.name}.json`;
  fs.writeFileSync(path, JSON.stringify(exp, null, 2));
  console.log(`wrote ${path}`);
}
if (which === 'all') {
  const summary = { ranAt: new Date().toISOString(), experiments: chosen };
  fs.writeFileSync('/tmp/rubric-exp-summary.json', JSON.stringify(summary, null, 2));
  console.log('wrote /tmp/rubric-exp-summary.json');
}

// Pretty-print condensed table.
for (const exp of chosen) {
  console.log(`\n=== ${exp.name} ===`);
  console.log(`  hypothesis: ${exp.hypothesis}`);
  console.log(`  prediction: ${exp.prediction}`);
  for (const v of exp.variants) {
    console.log(`  ${v.label.padEnd(30)} P=${v.precision} R=${v.recall} F1=${v.f1} | buyer=${v.buyerRecall ?? '-'} engager=${v.engagerRecall ?? '-'} noise_pass=${v.noiseRecall ?? '-'}`);
  }
}
