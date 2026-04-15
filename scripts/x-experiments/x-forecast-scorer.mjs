/**
 * x-forecast-scorer.mjs — daily job that judges predictions emitted by
 * x-intel.mjs once their `by_when` date has passed.
 *
 * Flow:
 *   1. Read ~/.ohwow/workspaces/<ws>/x-intel-history.jsonl, collect every
 *      prediction whose by_when <= today.
 *   2. Skip any prediction id already present in
 *      ~/.ohwow/workspaces/<ws>/x-predictions-scores.jsonl (idempotent).
 *   3. For each unjudged prediction, ask purpose=reasoning to verdict it
 *      against evidence = the bucket's subsequent history rows +
 *      surrounding posts in x-seen.jsonl.
 *   4. Append {id, bucket, made_at, by_when, judged_at, verdict, rationale,
 *      confidence} to x-predictions-scores.jsonl.
 *
 * Safety:
 *   - Read-only wrt workspace knowledge — never uploads, never proposes
 *     approvals.
 *   - Cost cap: at most MAX_JUDGED_PER_RUN predictions per invocation.
 *   - Idempotent: rerunning on the same day after a crash resumes cleanly.
 *
 * Env:
 *   DRY=1            — parse + count, no LLM calls, no writes.
 *   MAX_JUDGED=N     — override cost cap (default 25 per run).
 *   EVIDENCE_DAYS=N  — how far forward from by_when to pull evidence (default 14).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { llm, resolveOhwow, extractJson } from './_ohwow.mjs';

const DRY = process.env.DRY === '1';
const MAX_JUDGED_PER_RUN = Number(process.env.MAX_JUDGED || 25);
const EVIDENCE_DAYS = Number(process.env.EVIDENCE_DAYS || 14);

function wsPath(workspace, name) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, name);
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function collectMaturedPredictions(historyRows, scoredIds, today) {
  const matured = [];
  for (const row of historyRows) {
    if (!Array.isArray(row.predictions)) continue;
    for (const pred of row.predictions) {
      if (!pred?.id || !pred.by_when) continue;
      if (pred.by_when > today) continue;
      if (scoredIds.has(pred.id)) continue;
      matured.push({
        id: pred.id,
        bucket: row.bucket,
        made_at: pred.made_at || row.date,
        by_when: pred.by_when,
        what: pred.what,
        confidence: pred.confidence ?? 0.5,
        citations: pred.citations || [],
      });
    }
  }
  return matured;
}

export function buildEvidence(historyRows, seenRows, pred, evidenceDays) {
  const start = pred.made_at;
  const windowEnd = new Date(new Date(pred.by_when).getTime() + evidenceDays * 86400_000).toISOString().slice(0, 10);
  const bucketRows = historyRows
    .filter(r => r.bucket === pred.bucket && r.date > start && r.date <= windowEnd)
    .slice(-8);
  const historyBlock = bucketRows.length
    ? bucketRows.map(r => `- ${r.date} · ${r.headline}${r.emerging_patterns?.length ? `\n  patterns: ${r.emerging_patterns.slice(0, 3).join(' | ')}` : ''}`).join('\n')
    : '(no later briefs for this bucket)';
  const cited = new Set(pred.citations || []);
  const citedPosts = seenRows.filter(s => cited.has(s.permalink)).slice(0, 6);
  const citedBlock = citedPosts.length
    ? citedPosts.map(s => `- @${s.author} ${s.datetime || ''} perma=${s.permalink} class=${s.class || ''}`).join('\n')
    : '(cited posts no longer in seen store)';
  return { historyBlock, citedBlock, windowEnd };
}

async function judgePrediction(pred, evidence) {
  const sys = `You are a calibration judge. Verdict this prediction against evidence: did it happen, partially, or miss?

Output STRICT JSON: {"verdict":"hit"|"partial"|"miss","confidence":0.0..1.0,"rationale":"<=30 words"}
- hit: the predicted outcome clearly happened by the date.
- partial: something close happened but the specifics missed (wrong actor, late, smaller scope).
- miss: it did not happen or the opposite happened.
Be strict. If evidence is thin, prefer miss over hit.`;
  const prompt = `Prediction (made ${pred.made_at}, due ${pred.by_when}, bucket=${pred.bucket}):
${pred.what}

Later briefs for this bucket (${pred.made_at} → ${evidence.windowEnd}):
${evidence.historyBlock}

Posts cited when the prediction was made:
${evidence.citedBlock}`;
  const resp = await llm({ purpose: 'reasoning', system: sys, prompt });
  const parsed = extractJson(resp.text);
  return {
    verdict: ['hit', 'partial', 'miss'].includes(parsed.verdict) ? parsed.verdict : 'miss',
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    rationale: String(parsed.rationale || '').slice(0, 240),
    _usage: resp,
  };
}

async function main() {
  const { workspace } = resolveOhwow();
  const today = new Date().toISOString().slice(0, 10);
  const t0 = Date.now();
  const budget = { llmCalls: 0, tokensIn: 0, tokensOut: 0, costCents: 0, judged: 0, hits: 0, partials: 0, misses: 0 };
  console.log(`[x-forecast-scorer] workspace=${workspace} date=${today} dry=${DRY}`);

  const historyRows = readJsonl(wsPath(workspace, 'x-intel-history.jsonl'));
  const scoredRows = readJsonl(wsPath(workspace, 'x-predictions-scores.jsonl'));
  const seenRows = readJsonl(wsPath(workspace, 'x-seen.jsonl'));
  const scoredIds = new Set(scoredRows.map(r => r.id));
  const matured = collectMaturedPredictions(historyRows, scoredIds, today);
  console.log(`[x-forecast-scorer] ${matured.length} matured unjudged predictions (scored so far: ${scoredIds.size})`);

  if (DRY || !matured.length) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[x-forecast-scorer] report: ${elapsed}s · 0 llm calls · 0 judged (dry=${DRY})`);
    return;
  }

  const toJudge = matured.slice(0, MAX_JUDGED_PER_RUN);
  const scoresFile = wsPath(workspace, 'x-predictions-scores.jsonl');
  fs.mkdirSync(path.dirname(scoresFile), { recursive: true });

  for (const pred of toJudge) {
    try {
      const evidence = buildEvidence(historyRows, seenRows, pred, EVIDENCE_DAYS);
      const j = await judgePrediction(pred, evidence);
      budget.llmCalls++;
      budget.tokensIn += j._usage.tokens?.input || 0;
      budget.tokensOut += j._usage.tokens?.output || 0;
      budget.costCents += j._usage.cost_cents || 0;
      budget.judged++;
      if (j.verdict === 'hit') budget.hits++;
      else if (j.verdict === 'partial') budget.partials++;
      else budget.misses++;
      const record = {
        id: pred.id,
        bucket: pred.bucket,
        made_at: pred.made_at,
        by_when: pred.by_when,
        judged_at: new Date().toISOString(),
        verdict: j.verdict,
        rationale: j.rationale,
        confidence: j.confidence,
        what: pred.what,
        claimed_confidence: pred.confidence,
      };
      fs.appendFileSync(scoresFile, JSON.stringify(record) + '\n');
      console.log(`  ${pred.bucket}/${pred.id.slice(0, 8)} → ${j.verdict} (${j.confidence.toFixed(2)}) — ${j.rationale.slice(0, 80)}`);
    } catch (e) {
      console.error(`  judge failed for ${pred.id}: ${e.message}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const remaining = matured.length - toJudge.length;
  console.log(`\n[x-forecast-scorer] report: ${elapsed}s · ${budget.llmCalls} llm calls · ${budget.tokensIn} in / ${budget.tokensOut} out tok · ${(budget.costCents / 100).toFixed(3)} USD · ${budget.judged} judged (${budget.hits} hit / ${budget.partials} partial / ${budget.misses} miss)${remaining ? ` · ${remaining} deferred to next run (cap=${MAX_JUDGED_PER_RUN})` : ''}`);
}

// Only run main when invoked as a script, not when imported for tests.
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  main().catch(e => { console.error(e); process.exit(1); });
}
