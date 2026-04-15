#!/usr/bin/env node
/**
 * E5 — intent classifier confidence calibration. Hits the real LLM via
 * the ohwow daemon's /api/llm (purpose: simple_classification). Budget:
 * 20 calls hard cap. Records confidence distribution vs. ground truth.
 *
 * Prediction: confidence on buyer-labeled rows is bimodal (peaks near
 * 0.5 and 0.85); noise scores predictably low. Flat/inverted = prompt
 * needs rework.
 */
import fs from 'node:fs';
import { loadFixture, defaultRubric } from './_tune-rubric.mjs';
import { classifyIntent } from './_qualify.mjs';
import { llm, extractJson } from './_ohwow.mjs';

const BUDGET = Number(process.env.E5_BUDGET || 20);
const rows = loadFixture();

// Pick a stratified sample: 8 buyers, 5 builders, 5 noise, 2 engagers.
// Keeps spend predictable and gives us all four truth classes.
function pickSample(rows) {
  const pick = (truth, n) => rows.filter(r => r.__truth === truth).slice(0, n);
  return [
    ...pick('buyer', 8),
    ...pick('builder', 5),
    ...pick('noise', 5),
    ...pick('engager', 2),
  ];
}

async function main() {
  const rubric = defaultRubric();
  const sample = pickSample(rows).slice(0, BUDGET);
  console.log(`[E5] sampling ${sample.length} rows, budget ${BUDGET} calls`);
  console.log(`[E5] truthDist: ${JSON.stringify(sample.reduce((a, r) => ({ ...a, [r.__truth]: (a[r.__truth] || 0) + 1 }), {}))}`);

  const results = [];
  let spend = 0;
  let calls = 0;
  const llmFn = async (args) => {
    calls++;
    // Include the excerpt in the prompt so the classifier has real text
    // to read, not just metadata. Real production adds this at the
    // sidecar layer; we simulate it here.
    const enrichedPrompt = `${args.prompt}\n\nRecent post excerpt:\n${args._excerpt || '(none)'}`;
    const r = await llm({ purpose: 'simple_classification', prompt: enrichedPrompt });
    // Rough spend estimate: simple_classification usually routes to a
    // cheap small model (~$0.0001-0.0005 per call). Track by call count
    // as the lower bound; detailed $ requires model-cost lookup.
    spend += 0.0003;
    return r?.text ?? r;
  };

  for (const row of sample) {
    try {
      const r = await classifyIntent(
        { ...row, _excerpt: row.excerpt },
        rubric,
        (args) => llmFn({ ...args, _excerpt: row.excerpt }),
        { extractJson },
      );
      results.push({ handle: row.handle, truth: row.__truth, ...r });
      console.log(`  @${row.handle.padEnd(22)} truth=${row.__truth.padEnd(8)} → ${r.intent.padEnd(18)} conf=${r.confidence.toFixed(2)}`);
    } catch (e) {
      console.log(`  @${row.handle} FAILED: ${e.message}`);
      results.push({ handle: row.handle, truth: row.__truth, error: e.message });
    }
    if (calls >= BUDGET) break;
  }

  // Analyze confidence distribution.
  const byTruth = {};
  for (const r of results) {
    if (r.error) continue;
    byTruth[r.truth] ??= [];
    byTruth[r.truth].push(r.confidence);
  }

  const report = {
    ts: new Date().toISOString(),
    calls,
    spendUsdEstimate: +spend.toFixed(4),
    sample: results,
    summaryByTruth: Object.fromEntries(Object.entries(byTruth).map(([k, v]) => [k, {
      n: v.length,
      mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3),
      min: Math.min(...v),
      max: Math.max(...v),
    }])),
    calibrationVerdict: (() => {
      const buyers = byTruth.buyer || [];
      const noise = byTruth.noise || [];
      if (!buyers.length || !noise.length) return 'insufficient-data';
      const buyerMean = buyers.reduce((a, b) => a + b, 0) / buyers.length;
      const noiseMean = noise.reduce((a, b) => a + b, 0) / noise.length;
      if (buyerMean - noiseMean < 0.1) return 'inverted-or-flat (prompt needs rework)';
      if (buyerMean - noiseMean < 0.2) return 'weak (consider rework)';
      return 'well-calibrated';
    })(),
  };
  const out = '/tmp/rubric-exp-E5-classifier-calibration.json';
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n[E5] wrote ${out}`);
  console.log(`[E5] calls=${calls} spend~$${report.spendUsdEstimate}`);
  console.log(`[E5] verdict: ${report.calibrationVerdict}`);
  console.log(`[E5] byTruth: ${JSON.stringify(report.summaryByTruth)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
