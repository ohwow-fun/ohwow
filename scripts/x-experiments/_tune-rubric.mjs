#!/usr/bin/env node
/**
 * Synthetic-corpus rubric tuner. Runs the free-gate cascade from
 * _qualify.mjs against a labeled author fixture and reports precision
 * + recall vs. ground truth. Invoked by the experiment scripts (E1–E4)
 * to sweep rubric parameters.
 *
 * The fixture lives at __tests__/fixtures/labeled-authors.jsonl. Each
 * row has a __truth ∈ {buyer, builder, noise, engager}. We treat
 * {buyer, engager} as "should pass" and {builder, noise} as "should
 * reject". This is intentionally coarse — a builder may convert someday
 * but not on this pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { freeGates } from './_qualify.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '__tests__/fixtures/labeled-authors.jsonl');

const POSITIVE_TRUTHS = new Set(['buyer', 'engager']);

export function loadFixture(p = FIXTURE) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/**
 * Score a rubric against the corpus. Precision = of authors the rubric
 * let through, fraction truly positive. Recall = of truly positive
 * authors, fraction the rubric let through.
 */
export function scoreRubric(rubric, rows) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const falsePositives = [];
  const falseNegatives = [];
  for (const row of rows) {
    const verdict = freeGates(rubric, row);
    const passed = verdict.decision === 'pass';
    const positive = POSITIVE_TRUTHS.has(row.__truth);
    if (passed && positive) tp++;
    else if (passed && !positive) { fp++; falsePositives.push(row.handle); }
    else if (!passed && positive) { fn++; falseNegatives.push(row.handle); }
    else tn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return {
    tp, fp, fn, tn,
    precision: +precision.toFixed(3),
    recall: +recall.toFixed(3),
    f1: +f1.toFixed(3),
    falsePositives, falseNegatives,
  };
}

/** Subset by truth class for per-class recall. */
export function recallForTruth(rubric, rows, truth) {
  const subset = rows.filter(r => r.__truth === truth);
  if (!subset.length) return 0;
  const passed = subset.filter(r => freeGates(rubric, r).decision === 'pass').length;
  return +(passed / subset.length).toFixed(3);
}

/** Deep-merge override onto base rubric (only the shapes we care about). */
export function withOverride(base, override) {
  return {
    ...base,
    freeGates: {
      ...(base.freeGates || {}),
      ...(override.freeGates || {}),
      engagerBoost: {
        ...(base.freeGates?.engagerBoost || {}),
        ...(override.freeGates?.engagerBoost || {}),
      },
    },
    icp: { ...(base.icp || {}), ...(override.icp || {}) },
    intentClassifier: { ...(base.intentClassifier || {}), ...(override.intentClassifier || {}) },
  };
}

const DEFAULT_RUBRIC = {
  icp: { description: 'small-team founders / solopreneurs escaping manual ops', disqualifiers: ['bot', 'agency'] },
  freeGates: {
    minScore: 0.6,
    minReplies: 0,
    minLikes: 0,
    minTouches: 1,
    allowedBuckets: ['market_signal', 'competitors'],
    engagerBoost: { ownPostReplyReducesMinScoreTo: 0.4 },
  },
  intentClassifier: { minConfidence: 0.7, acceptClasses: ['buyer_intent'] },
};

export function defaultRubric() {
  return JSON.parse(JSON.stringify(DEFAULT_RUBRIC));
}

// CLI: `node _tune-rubric.mjs baseline` prints baseline scores.
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('_tune-rubric.mjs');
if (isMain) {
  const rows = loadFixture();
  const base = defaultRubric();
  const report = scoreRubric(base, rows);
  console.log(JSON.stringify({
    fixture: FIXTURE,
    totalRows: rows.length,
    truthDist: rows.reduce((a, r) => { a[r.__truth] = (a[r.__truth] || 0) + 1; return a; }, {}),
    baseline: report,
    engagerRecall: recallForTruth(base, rows, 'engager'),
    buyerRecall: recallForTruth(base, rows, 'buyer'),
    builderRecall: recallForTruth(base, rows, 'builder'),
    noiseRecall: recallForTruth(base, rows, 'noise'),
  }, null, 2));
}
