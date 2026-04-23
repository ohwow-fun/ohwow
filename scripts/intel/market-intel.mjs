/**
 * market-intel.mjs — unified strategic intelligence pipeline for ohwow.
 *
 * Replaces x-intel (suspended X account). Pulls from:
 *   - Reddit  (buyer_intent leads: hiring posts in creator communities)
 *   - HuggingFace (model releases from Gemini, Kimi, Qwen, DeepSeek, etc.)
 *   - ArXiv   (cs.AI/LG/MA papers with product implications)
 *   - RSS     (AI lab blogs: Anthropic, OpenAI, DeepMind, Mistral, HF)
 *
 * All output is written as structured JSON for easy downstream parsing.
 *
 * Output files (in ~/.ohwow/workspaces/<ws>/intel/):
 *   YYYY-MM-DD/items-raw.json          — all collected items before classification
 *   YYYY-MM-DD/items-classified.json   — items with bucket/score/tags/why
 *   YYYY-MM-DD/briefs.json             — per-bucket strategic briefs
 *   YYYY-MM-DD/buyer-leads.json        — buyer_intent items → CRM candidates
 *   YYYY-MM-DD/model-releases.json     — model_release items only
 *   YYYY-MM-DD/research.json           — research_advance items only
 *   YYYY-MM-DD/run-summary.json        — budget, counts, timing
 *   market-intel-seen.jsonl            — dedup across runs (append-only)
 *
 * Usage:
 *   npx tsx scripts/intel/market-intel.mjs
 *   DRY=1 npx tsx scripts/intel/market-intel.mjs       # collect+classify only, no synthesis
 *   SOURCES=reddit,arxiv npx tsx ...                   # subset sources
 *   MAX_AGE_H=24 npx tsx ...                           # only items from last 24h
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { llm, resolveOhwow, ingestKnowledgeFile } from '../x-experiments/_ohwow.mjs';
import { propose } from '../x-experiments/_approvals.mjs';
import { fetchReddit } from './_sources/reddit.mjs';
import { fetchHuggingFace } from './_sources/huggingface.mjs';
import { fetchArxiv } from './_sources/arxiv.mjs';
import { fetchRss } from './_sources/rss.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DRY = process.env.DRY === '1';
const SOURCES_ENV = process.env.SOURCES || 'reddit,huggingface,arxiv,rss';
const ENABLED_SOURCES = new Set(SOURCES_ENV.split(',').map(s => s.trim().toLowerCase()));
const MAX_AGE_H = Number(process.env.MAX_AGE_H) || 72;
const CLASSIFY_BATCH = 20;
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || 7;

const BUCKETS = {
  buyer_intent:     'People actively looking to hire or buy services ohwow serves (video editors, content automation, AI workflows)',
  model_release:    'New AI model announced or released — affects ohwow execution stack, costs, and competitive landscape',
  research_advance: 'Academic paper with near-term product implications for autonomous agents, LLM planning, or multi-agent systems',
  competitor_move:  'Competing product launched, updated, or gained traction in ohwow\'s market',
  market_signal:    'Broader trend, pricing change, community sentiment, or strategic signal worth tracking',
  skip:             'Not relevant to ohwow — noise, unrelated domain, or duplicate angle',
};

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------
const { workspace } = resolveOhwow();
const wsDir = path.join(os.homedir(), '.ohwow', 'workspaces', workspace);
const intelDir = path.join(wsDir, 'intel');
const today = new Date().toISOString().slice(0, 10);
const runDir = path.join(intelDir, today);
const seenPath = path.join(intelDir, 'market-intel-seen.jsonl');

fs.mkdirSync(runDir, { recursive: true });

function writeJson(filename, data) {
  const p = path.join(runDir, filename);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

// ---------------------------------------------------------------------------
// Seen-file dedup
// ---------------------------------------------------------------------------
function loadSeen() {
  const seen = new Set();
  if (!fs.existsSync(seenPath)) return seen;
  const lines = fs.readFileSync(seenPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try { seen.add(JSON.parse(line).id); } catch {}
  }
  return seen;
}

function appendSeen(items) {
  const lines = items.map(item => JSON.stringify({ id: item.id, ts: new Date().toISOString() }));
  fs.appendFileSync(seenPath, lines.join('\n') + (lines.length ? '\n' : ''));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
function formatItemLine(item, idx) {
  const parts = [`#${idx}`];
  parts.push(`[${item.source_type}${item.source_label ? '/' + item.source_label : ''}]`);
  if (item.score > 0) parts.push(`${item.score}♥`);
  if (item.upvotes > 0) parts.push(`${item.upvotes}▲`);
  if (item.age_h != null) parts.push(`${item.age_h}h`);
  parts.push(item.title);
  if (item.text && item.text !== item.title) {
    parts.push(`— ${item.text.slice(0, 200)}`);
  }
  return parts.join(' ');
}

const CLASSIFY_SYSTEM = `You are a strategic intelligence analyst for ohwow — an autonomous AI business OS for solo founders and small teams.

BUCKETS (pick exactly one):
${Object.entries(BUCKETS).map(([k, v]) => `  ${k}: ${v}`).join('\n')}

ohwow context:
- Runtime: autonomous conductor that picks tasks, runs plan→impl→QA trios
- ICP: content creators, YouTubers, video editors, AI-curious founders
- Stack: TypeScript, SQLite, Node.js, multi-model routing (Anthropic, OpenRouter, Ollama)
- Goal: grow MRR by finding + nurturing buyer_intent contacts and shipping product improvements
- Model strategy: prefer cheap models (haiku, gemma, deepseek-v3) for routine tasks, escalate deliberately

CRITICAL RULES for buyer_intent:
- buyer_intent ONLY when a person or business EXPLICITLY posts that they are HIRING or PAYING for a service ohwow could fulfill
- Must have clear intent to pay (budget mentioned, "[Hiring]", "[For Hire]", "looking to hire", "need someone to")
- AI model benchmarks, comparisons, or performance discussions = model_release or market_signal, NEVER buyer_intent
- General creator tips, growth stories, tutorials = market_signal or skip, NEVER buyer_intent
- A post about testing Qwen27B speed = market_signal, not buyer_intent

Score 0.0–1.0 (how strategically relevant to ohwow). Items with score < 0.40 → bucket 'skip'.

Respond ONLY with valid JSON (no markdown fences): { "items": [{ "n": 1, "bucket": "...", "score": 0.85, "tags": ["tag1", "tag2"], "why": "one concise sentence" }, ...] }`;

async function classifyBatch(items, batchOffset, attempt = 1) {
  const lines = items.map((item, i) => formatItemLine(item, batchOffset + i + 1)).join('\n');
  const prompt = `Classify these ${items.length} intelligence items:\n\n${lines}`;

  try {
    const result = await llm({ purpose: 'simple_classification', prompt, system: CLASSIFY_SYSTEM, max_tokens: 2000 });
    const text = typeof result === 'string' ? result : result?.text || result?.content || JSON.stringify(result);

    // Extract JSON — try full object first, then try to salvage partial arrays
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in response');
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.items || [];
    } catch (parseErr) {
      // Truncated JSON: extract any complete item objects from partial array
      const itemMatches = [...jsonMatch[0].matchAll(/\{\s*"n"\s*:\s*(\d+)[^}]*\}/g)];
      if (itemMatches.length > 0) {
        const rescued = itemMatches.map(m => { try { return JSON.parse(m[0]); } catch { return null; } }).filter(Boolean);
        if (rescued.length > 0) {
          console.warn(`[classify] batch ${batchOffset} partial parse: rescued ${rescued.length}/${items.length} items`);
          return rescued;
        }
      }
      if (attempt < 2) {
        console.warn(`[classify] batch ${batchOffset} parse failed, retrying...`);
        await new Promise(r => setTimeout(r, 1500));
        return classifyBatch(items, batchOffset, attempt + 1);
      }
      throw parseErr;
    }
  } catch (err) {
    console.warn(`[classify] batch ${batchOffset} failed (attempt ${attempt}): ${err.message}`);
    return items.map((_, i) => ({ n: batchOffset + i + 1, bucket: 'market_signal', score: 0.4, tags: [], why: 'classification error' }));
  }
}

async function classifyAll(items) {
  const results = [];
  for (let i = 0; i < items.length; i += CLASSIFY_BATCH) {
    const batch = items.slice(i, i + CLASSIFY_BATCH);
    const classified = await classifyBatch(batch, i);
    results.push(...classified);
    if (i + CLASSIFY_BATCH < items.length) {
      await new Promise(r => setTimeout(r, 800)); // rate limit courtesy
    }
  }

  // Merge classification results back into items
  for (const item of results) {
    const idx = item.n - 1;
    if (idx >= 0 && idx < items.length) {
      items[idx].bucket = item.bucket || 'skip';
      items[idx].bucket_score = item.score ?? 0;
      items[idx].bucket_tags = item.tags || [];
      items[idx].why = item.why || '';
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Synthesis (one strategic brief per non-skip bucket)
// ---------------------------------------------------------------------------
const BRIEF_SYSTEM = `You are a strategic intelligence officer briefing the CEO of ohwow — an autonomous AI business OS.

ohwow context:
- Autonomous conductor runs plan→impl→QA trios for business tasks
- ICP: content creators, YouTubers, video editors needing AI automation
- Current state: 0 MRR, ~6 active leads, building toward first revenue
- Stack: TypeScript/Node.js/SQLite, routes between Anthropic + OpenRouter + Ollama
- Priorities: (1) qualified lead generation, (2) product shipping velocity, (3) cost efficiency

Write a brief in this exact JSON schema (no markdown wrapper):
{
  "bucket": "<bucket_name>",
  "headline": "<1 punchy sentence: what changed and why it matters>",
  "key_signals": ["<signal>", ...],
  "ohwow_implications": ["<how this affects ohwow product/ops/strategy>", ...],
  "action_items": ["<specific, concrete next action>", ...],
  "watch_next": ["<what to monitor>"],
  "predictions": [{ "what": "...", "by_when": "YYYY-MM", "confidence": 0.0 }]
}

Be direct. No hedging. Every point should be actionable or specific. Max 5 items per array.`;

async function synthesizeBucket(bucket, items, priorHistory) {
  const itemLines = items.map((item, i) => {
    const tags = (item.bucket_tags || []).join(', ');
    return `${i + 1}. [${item.source_type}] ${item.title} (score: ${item.bucket_score?.toFixed(2)}, tags: ${tags})\n   ${(item.text || '').slice(0, 300)}\n   ${item.url}`;
  }).join('\n\n');

  const historyBlock = priorHistory.length > 0
    ? `\nPrior ${bucket} signals from last ${HISTORY_DAYS} days:\n${priorHistory.slice(0, 5).map(h => `- ${h.headline || h.key_signals?.[0] || ''}`).join('\n')}`
    : '';

  const prompt = `Synthesize a strategic brief for the "${bucket}" bucket.\n\nItems (${items.length}):\n${itemLines}${historyBlock}`;

  try {
    const result = await llm({ purpose: 'reasoning', prompt, system: BRIEF_SYSTEM, max_tokens: 1500 });
    const text = typeof result === 'string' ? result : result?.text || result?.content || JSON.stringify(result);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in response');
    const brief = JSON.parse(jsonMatch[0]);
    brief.bucket = bucket;
    brief.item_count = items.length;
    brief.generated_at = new Date().toISOString();
    return brief;
  } catch (err) {
    console.warn(`[synthesize] ${bucket} failed: ${err.message}`);
    return {
      bucket,
      headline: `${items.length} ${bucket} signals collected`,
      key_signals: items.slice(0, 3).map(i => i.title),
      ohwow_implications: [],
      action_items: [],
      watch_next: [],
      predictions: [],
      item_count: items.length,
      generated_at: new Date().toISOString(),
      error: err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// History loader (for synthesis context)
// ---------------------------------------------------------------------------
function loadPriorBriefs(bucket) {
  const briefs = [];
  for (let d = 1; d <= HISTORY_DAYS; d++) {
    const date = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    const p = path.join(intelDir, date, 'briefs.json');
    if (!fs.existsSync(p)) continue;
    try {
      const all = JSON.parse(fs.readFileSync(p, 'utf8'));
      const b = Array.isArray(all) ? all.find(x => x.bucket === bucket) : null;
      if (b) briefs.push(b);
    } catch {}
  }
  return briefs;
}

// ---------------------------------------------------------------------------
// CRM promotion for buyer_intent
// ---------------------------------------------------------------------------
function extractBuyerLeads(classified) {
  return classified
    .filter(i => i.bucket === 'buyer_intent' && (i.bucket_score || 0) >= 0.6)
    .map(item => ({
      id: item.id,
      title: item.title,
      text: item.text,
      url: item.url,
      author: item.author,
      subreddit: item.subreddit,
      score: item.bucket_score,
      tags: item.bucket_tags,
      why: item.why,
      source_label: item.source_label,
      crm_status: 'candidate',
      reviewed: false,
    }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const t0 = Date.now();
console.log(`[market-intel] workspace=${workspace} date=${today} dry=${DRY} sources=${SOURCES_ENV} max_age_h=${MAX_AGE_H}`);

// 1. COLLECT -----------------------------------------------------------------
const rawItems = [];

if (ENABLED_SOURCES.has('reddit')) {
  const items = await fetchReddit({ maxAgeHours: MAX_AGE_H });
  rawItems.push(...items);
}
if (ENABLED_SOURCES.has('huggingface') || ENABLED_SOURCES.has('hf')) {
  const items = await fetchHuggingFace({ maxAgeHours: MAX_AGE_H });
  rawItems.push(...items);
}
if (ENABLED_SOURCES.has('arxiv')) {
  const items = await fetchArxiv({ maxAgeHours: MAX_AGE_H });
  rawItems.push(...items);
}
if (ENABLED_SOURCES.has('rss')) {
  const items = await fetchRss({ maxAgeHours: MAX_AGE_H * 1.5 }); // wider window for blogs
  rawItems.push(...items);
}

console.log(`[market-intel] collected ${rawItems.length} raw items`);
writeJson('items-raw.json', {
  generated_at: new Date().toISOString(),
  workspace,
  date: today,
  sources_enabled: [...ENABLED_SOURCES],
  max_age_h: MAX_AGE_H,
  item_count: rawItems.length,
  items: rawItems,
});

// 2. DEDUP -------------------------------------------------------------------
const seen = loadSeen();
const fresh = rawItems.filter(item => !seen.has(item.id));
console.log(`[market-intel] ${fresh.length} new (${rawItems.length - fresh.length} already seen)`);

if (fresh.length === 0) {
  console.log('[market-intel] nothing new — exiting');
  writeJson('run-summary.json', {
    generated_at: new Date().toISOString(),
    workspace,
    date: today,
    collected: rawItems.length,
    new_items: 0,
    classified: 0,
    briefs: 0,
    buyer_leads: 0,
    duration_ms: Date.now() - t0,
    dry: DRY,
  });
  process.exit(0);
}

// 3. CLASSIFY ----------------------------------------------------------------
const budget = { llm_calls: 0, buyer_leads: 0, briefs: 0 };
console.log(`[market-intel] classifying ${fresh.length} items in batches of ${CLASSIFY_BATCH}...`);
const classified = await classifyAll(fresh);
budget.llm_calls += Math.ceil(fresh.length / CLASSIFY_BATCH);

// Save classified items
writeJson('items-classified.json', {
  generated_at: new Date().toISOString(),
  workspace,
  date: today,
  item_count: classified.length,
  items: classified,
});

// Bucket breakdown
const byBucket = {};
for (const item of classified) {
  if (!item.bucket || item.bucket === 'skip') continue;
  byBucket[item.bucket] = byBucket[item.bucket] || [];
  byBucket[item.bucket].push(item);
}
console.log('[market-intel] bucket breakdown:', Object.fromEntries(
  Object.entries(byBucket).map(([k, v]) => [k, v.length])
));

// Save focused slices
const buyerLeads = extractBuyerLeads(classified);
writeJson('buyer-leads.json', {
  generated_at: new Date().toISOString(),
  workspace,
  date: today,
  count: buyerLeads.length,
  leads: buyerLeads,
});
budget.buyer_leads = buyerLeads.length;

const modelReleases = classified.filter(i => i.bucket === 'model_release');
writeJson('model-releases.json', {
  generated_at: new Date().toISOString(),
  workspace,
  date: today,
  count: modelReleases.length,
  items: modelReleases.sort((a, b) => (b.bucket_score || 0) - (a.bucket_score || 0)),
});

const research = classified.filter(i => i.bucket === 'research_advance');
writeJson('research.json', {
  generated_at: new Date().toISOString(),
  workspace,
  date: today,
  count: research.length,
  items: research.sort((a, b) => (b.bucket_score || 0) - (a.bucket_score || 0)),
});

// Mark seen now (before synthesis — avoids re-classifying on partial run)
appendSeen(fresh);

// 4. SYNTHESIS (skip if DRY) -------------------------------------------------
const allBriefs = [];

if (!DRY) {
  const actionableBuckets = Object.keys(byBucket).filter(b => b !== 'skip' && byBucket[b]?.length > 0);
  console.log(`[market-intel] synthesizing ${actionableBuckets.length} bucket briefs...`);

  for (const bucket of actionableBuckets) {
    const items = byBucket[bucket];
    const priorBriefs = loadPriorBriefs(bucket);
    const brief = await synthesizeBucket(bucket, items, priorBriefs);
    allBriefs.push(brief);
    budget.llm_calls++;
    budget.briefs++;
    console.log(`[market-intel] brief:${bucket} — "${brief.headline?.slice(0, 80)}"`);
  }

  writeJson('briefs.json', {
    generated_at: new Date().toISOString(),
    workspace,
    date: today,
    bucket_count: allBriefs.length,
    briefs: allBriefs,
  });

  // 5. PROPOSE approval entries + knowledge upload ---------------------------
  for (const brief of allBriefs) {
    // Propose approval entry so operator can rate the brief quality
    const entry = propose({
      kind: 'market_intel_brief',
      summary: `[${brief.bucket}] ${brief.headline || `${brief.item_count} signals`}`,
      payload: {
        bucket: brief.bucket,
        date: today,
        brief,
        run_dir: runDir,
      },
      autoApproveAfter: 5,
      bucketBy: 'bucket',
      maxPriorRejected: 2,
    });

    // If trusted / auto-approved: upload to ohwow knowledge base
    if (entry.status === 'auto_applied') {
      const title = `Market Intel ${today}: ${brief.bucket}`;
      const md = [
        `# ${title}`,
        `**Date:** ${today}  **Bucket:** ${brief.bucket}  **Items:** ${brief.item_count}`,
        '',
        `## Headline`,
        brief.headline || '',
        '',
        brief.key_signals?.length ? `## Key Signals\n${brief.key_signals.map(s => `- ${s}`).join('\n')}` : '',
        '',
        brief.ohwow_implications?.length ? `## ohwow Implications\n${brief.ohwow_implications.map(s => `- ${s}`).join('\n')}` : '',
        '',
        brief.action_items?.length ? `## Action Items\n${brief.action_items.map(s => `- ${s}`).join('\n')}` : '',
        '',
        brief.predictions?.length ? `## Predictions\n${brief.predictions.map(p => `- ${p.what} (by ${p.by_when}, ${(p.confidence * 100).toFixed(0)}% confidence)`).join('\n')}` : '',
      ].filter(s => s !== null && s !== undefined).join('\n').trim();

      try {
        await ingestKnowledgeFile({
          title,
          filename: `market-intel-${today}-${brief.bucket}.md`,
          body: md,
          replace: true,
        });
        console.log(`[market-intel] uploaded to knowledge: ${title}`);
        budget.llm_calls++;
      } catch (err) {
        console.warn(`[market-intel] knowledge upload failed for ${brief.bucket}: ${err.message}`);
      }
    }
  }
}

// 6. RUN SUMMARY -------------------------------------------------------------
const summary = {
  generated_at: new Date().toISOString(),
  workspace,
  date: today,
  sources_enabled: [...ENABLED_SOURCES],
  dry: DRY,
  collected: rawItems.length,
  new_items: fresh.length,
  classified: classified.length,
  bucket_counts: Object.fromEntries(
    Object.entries(byBucket).map(([k, v]) => [k, v.length])
  ),
  buyer_leads: budget.buyer_leads,
  model_releases: modelReleases.length,
  research_papers: research.length,
  briefs: budget.briefs,
  llm_calls: budget.llm_calls,
  duration_ms: Date.now() - t0,
  output_dir: runDir,
};
writeJson('run-summary.json', summary);

console.log(`[market-intel] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`[market-intel] output: ${runDir}`);
console.log(`[market-intel] summary:`, {
  new_items: fresh.length,
  bucket_counts: summary.bucket_counts,
  buyer_leads: budget.buyer_leads,
  briefs: budget.briefs,
});
