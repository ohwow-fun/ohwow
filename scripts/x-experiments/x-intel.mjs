/**
 * x-intel.mjs — periodic X intelligence pipeline for an ohwow workspace.
 *
 * Reads a private per-workspace config at
 *   ~/.ohwow/workspaces/<ws>/x-config.json
 * (falls back to scripts/x-experiments/x-config.example.json for new users;
 * warns loudly that it's using placeholders).
 *
 * Flow:
 *   1. Collect posts from every enabled source (home feed, searches, profiles)
 *      reusing the same harvest primitives. Dedup against prior runs via
 *      ~/.ohwow/workspaces/<ws>/x-seen.jsonl.
 *   2. Apply config-defined filters (min engagement, retweets, language).
 *   3. Classify every NEW post into one primary bucket + secondary tags.
 *      Uses purpose=simple_classification so the workspace's cheap model
 *      handles the volume.
 *   4. Per bucket: synthesize a brief (purpose=reasoning). Propose an
 *      approval entry per bucket; auto_apply_after respects the config's
 *      per-bucket trust threshold so high-confidence buckets ship without
 *      a human.
 *
 *   USAGE=
 *     npx tsx scripts/x-experiments/x-intel.mjs           # full run
 *     BUCKETS=advancements,hacks npx tsx ... x-intel.mjs  # subset
 *     SOURCES=home,search npx tsx ... x-intel.mjs         # subset
 *     DRY=1 npx tsx ... x-intel.mjs                       # collect+classify only, no briefs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
import { openProfileWindow } from '../../src/execution/browser/chrome-lifecycle.ts';
import { llm, resolveOhwow, extractJson, ingestKnowledgeFile } from './_ohwow.mjs';
import { scrollAndHarvest, loadSeen, appendSeen, filterPosts } from './_x-harvest.mjs';
import { propose } from './_approvals.mjs';
import crypto from 'node:crypto';

function predictionId(bucketId, what) {
  return crypto.createHash('sha1').update(`${bucketId}::${what}`).digest('hex').slice(0, 16);
}

function scoresPath(workspace) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-predictions-scores.jsonl');
}

// Rolling N-day accuracy per bucket, computed from the scorer's output.
// Verdict weights: hit=1, partial=0.5, miss=0. Returns {bucketId: {n, acc}}.
function loadRollingAccuracy(workspace, daysBack = 30) {
  const p = scoresPath(workspace);
  if (!fs.existsSync(p)) return {};
  const cutoff = Date.now() - daysBack * 86400_000;
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.judged_at && new Date(r.judged_at).getTime() >= cutoff);
  const agg = {};
  for (const r of rows) {
    if (!agg[r.bucket]) agg[r.bucket] = { n: 0, sum: 0 };
    agg[r.bucket].n++;
    agg[r.bucket].sum += r.verdict === 'hit' ? 1 : r.verdict === 'partial' ? 0.5 : 0;
  }
  const out = {};
  for (const [b, v] of Object.entries(agg)) out[b] = { n: v.n, acc: v.sum / v.n };
  return out;
}

const DRY = process.env.DRY === '1';
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 5);
const BUCKET_FILTER = new Set((process.env.BUCKETS || '').split(',').map(s => s.trim()).filter(Boolean));
const SOURCE_FILTER = new Set((process.env.SOURCES || '').split(',').map(s => s.trim()).filter(Boolean));
const PROFILE = process.env.PROFILE || 'Profile 1';

function historyPath(workspace) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-intel-history.jsonl');
}

function loadHistory(workspace, bucketId, daysBack) {
  const p = historyPath(workspace);
  if (!fs.existsSync(p)) return [];
  const cutoff = Date.now() - daysBack * 86400_000;
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.bucket === bucketId && new Date(r.date).getTime() >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function appendHistory(workspace, record) {
  const p = historyPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(record) + '\n');
}

function loadConfig(workspace) {
  const priv = path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-config.json');
  if (fs.existsSync(priv)) return JSON.parse(fs.readFileSync(priv, 'utf8'));
  const example = path.resolve('scripts/x-experiments/x-config.example.json');
  console.warn(`[x-intel] no private config at ${priv}, falling back to example (placeholders!)`);
  return JSON.parse(fs.readFileSync(example, 'utf8'));
}

async function ensureTab(browser) {
  let page = await findOrOpenXTab(browser);
  if (page) return page;
  await openProfileWindow({ profileDir: PROFILE, url: 'https://x.com/home', timeoutMs: 15000 });
  await new Promise(r => setTimeout(r, 2500));
  page = await findOrOpenXTab(browser);
  if (!page) throw new Error('could not open x.com tab');
  return page;
}

// --- main --------------------------------------------------------------

const { workspace } = resolveOhwow();
const cfg = loadConfig(workspace);
const today = new Date().toISOString().slice(0, 10);
const t0 = Date.now();
const budget = { llmCalls: 0, tokensIn: 0, tokensOut: 0, costCents: 0, uploads: 0, autoApplied: 0, pending: 0, predictionsEmitted: 0 };
console.log(`[x-intel] workspace=${workspace} date=${today} dry=${DRY}`);
console.log(`[x-intel] buckets: ${cfg.buckets.map(b => b.id).join(', ')}`);

const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
const page = await ensureTab(browser);
await page.installUnloadEscapes();

// 1. COLLECT ------------------------------------------------------------

const allPosts = new Map(); // permalink → { ...post, sources: [] }
function addPosts(posts, sourceId) {
  for (const p of posts) {
    const existing = allPosts.get(p.permalink);
    if (existing) { existing.sources.push(sourceId); continue; }
    allPosts.set(p.permalink, { ...p, sources: [sourceId] });
  }
}

if ((!SOURCE_FILTER.size || SOURCE_FILTER.has('home')) && cfg.sources.home_feed?.enabled) {
  console.log(`\n[x-intel] source=home_feed`);
  const posts = await scrollAndHarvest(page, 'https://x.com/home', cfg.sources.home_feed.max_scrolls ?? 20);
  console.log(`  +${posts.length} posts`);
  addPosts(posts, 'home_feed');
}

if (!SOURCE_FILTER.size || SOURCE_FILTER.has('search')) {
  for (const s of cfg.sources.searches || []) {
    console.log(`\n[x-intel] source=search "${s.query}"`);
    const url = `https://x.com/search?q=${encodeURIComponent(s.query)}&f=live`;
    const posts = await scrollAndHarvest(page, url, s.max_scrolls ?? 6);
    console.log(`  +${posts.length} posts`);
    addPosts(posts.map(p => ({ ...p, _bucketHint: s.bucket_hint })), `search:${s.query}`);
  }
}

if (!SOURCE_FILTER.size || SOURCE_FILTER.has('profile')) {
  for (const p of cfg.sources.profiles || []) {
    console.log(`\n[x-intel] source=profile @${p.handle}`);
    const posts = await scrollAndHarvest(page, `https://x.com/${p.handle}`, p.max_scrolls ?? 4);
    console.log(`  +${posts.length} posts`);
    addPosts(posts.map(x => ({ ...x, _bucketHint: p.bucket_hint })), `profile:${p.handle}`);
  }
}

console.log(`\n[x-intel] collected ${allPosts.size} unique posts across sources`);

// 2. FILTER + DEDUP AGAINST PRIOR RUNS ----------------------------------

const seen = loadSeen(workspace);
const candidates = Array.from(allPosts.values());
const filtered = filterPosts(candidates, cfg.filters || {});
const fresh = filtered.filter(p => !seen.has(p.permalink));
console.log(`[x-intel] filter: ${candidates.length} → ${filtered.length} post-filters → ${fresh.length} fresh (dedup against ${seen.size} prior)`);

if (!fresh.length) {
  console.log('[x-intel] nothing new — exiting');
  browser.close();
  process.exit(0);
}

// Cap to budget
const capped = fresh.slice(0, cfg.budget?.max_posts_per_run ?? 200);

// 3. CLASSIFY -----------------------------------------------------------

const bucketCatalog = cfg.buckets.map(b => `  ${b.id}: ${b.description}`).join('\n');
const classifySys = `You classify X posts for this team: ${cfg.workspace_description}
Assign each post to ONE primary bucket plus zero or more secondary tags.
Buckets:
${bucketCatalog}
  skip: none of the above / off-topic / spam / personal / ad / NSFW

Output STRICT JSON: {"classes":[{"i":0,"b":"advancements","tags":["llm","eval"],"score":0.0..1.0,"why":"<=12 words"},...]}
Score = how actionable for us (1 = must-read). Include EVERY input index in the output array.`;

const BATCH = 20;
const classes = new Map();
for (let offset = 0; offset < capped.length; offset += BATCH) {
  const batch = capped.slice(offset, offset + BATCH);
  const body = batch.map((p, i) => {
    const hint = p._bucketHint ? ` [hint:${p._bucketHint}]` : '';
    return `#${i} @${p.author}${hint} ${p.likes}♥ ${p.replies}💬: ${p.text.slice(0, 220).replace(/\n/g, ' ')}`;
  }).join('\n');
  try {
    const resp = await llm({ purpose: 'simple_classification', system: classifySys, prompt: body });
    budget.llmCalls++; budget.tokensIn += resp.tokens?.input || 0; budget.tokensOut += resp.tokens?.output || 0; budget.costCents += resp.cost_cents || 0;
    const parsed = extractJson(resp.text);
    for (const c of parsed.classes || []) {
      const p = batch[c.i];
      if (p) classes.set(p.permalink, c);
    }
    console.log(`  classified batch ${Math.floor(offset / BATCH) + 1}/${Math.ceil(capped.length / BATCH)} via ${resp.model_used}`);
  } catch (e) {
    console.error(`  classifier batch ${offset}: ${e.message}`);
  }
}

// Attach classifications
for (const p of capped) {
  const c = classes.get(p.permalink);
  p._class = c?.b || p._bucketHint || 'skip';
  p._score = c?.score ?? 0;
  p._tags = c?.tags || [];
  p._why = c?.why || '';
}

// Bucket grouping
const byBucket = {};
for (const b of cfg.buckets) byBucket[b.id] = [];
for (const p of capped) {
  if (byBucket[p._class]) byBucket[p._class].push(p);
}
for (const b of Object.keys(byBucket)) {
  byBucket[b].sort((a, z) => (z._score || 0) - (a._score || 0));
}

console.log('\n[x-intel] bucket counts:');
for (const [b, posts] of Object.entries(byBucket)) console.log(`  ${b.padEnd(14)} ${posts.length}`);
const skipped = capped.filter(p => p._class === 'skip').length;
console.log(`  skip           ${skipped}`);

// 4. COMMIT FRESH POSTS TO SEEN STORE (before synthesis, so even a failed synth doesn't re-ingest) -----

appendSeen(workspace, capped.map(p => ({
  permalink: p.permalink,
  author: p.author,
  datetime: p.datetime,
  firstSeenAt: new Date().toISOString(),
  class: p._class,
  score: p._score,
  tags: p._tags,
})));
console.log(`[x-intel] recorded ${capped.length} permalinks to x-seen.jsonl`);

if (DRY) {
  console.log('[x-intel] DRY=1 — stopping before synthesis/upload');
  browser.close();
  process.exit(0);
}

// 5. SYNTHESIZE + PROPOSE UPLOAD PER BUCKET -----------------------------

for (const bucketDef of cfg.buckets) {
  if (BUCKET_FILTER.size && !BUCKET_FILTER.has(bucketDef.id)) continue;
  const posts = byBucket[bucketDef.id] || [];
  if (!posts.length) { console.log(`\n[x-intel] bucket ${bucketDef.id}: no posts, skip`); continue; }
  const top = posts.slice(0, cfg.budget?.max_posts_synthesized_per_bucket ?? 25);

  const history = loadHistory(workspace, bucketDef.id, HISTORY_DAYS);
  const historyBlock = history.length
    ? `\n\nPrior briefs for this bucket (last ${HISTORY_DAYS} days, oldest→newest):\n${history.map(h => `- ${h.date} · ${h.headline}${h.emerging_patterns?.length ? `\n  patterns: ${h.emerging_patterns.slice(0, 3).join(' | ')}` : ''}`).join('\n')}\n\nWhen today's posts continue, confirm, contradict, or escalate a prior theme, CALL THAT OUT explicitly in headline or emerging_patterns. If today is a fresh theme, flag that too.`
    : '';

  const synthSys = `You produce a tight intelligence brief for this team: ${cfg.workspace_description}
Voice: ${cfg.brand_voice?.tone || 'direct, builder-to-builder'}

Bucket: "${bucketDef.label}" — ${bucketDef.description}${historyBlock}

Given raw X posts already classified into this bucket, produce STRICT JSON:
{
  "headline": "<=14 words summarizing what this bucket surfaced this run",
  "highlights": [ "bullet ending with (perma=/author/status/id)", ... ],   // 4-10
  "emerging_patterns": [ "bullet", ... ],                                    // 0-5, what's trending across multiple posts
  "continuity": [ "bullet on how today relates to prior briefs", ... ],      // 0-4, empty if no prior history
  "watch_next": [ "question or hypothesis to test next week", ... ],         // 0-4
  "skip_list": [ "perma=... — one-line why skipped", ... ],                  // low-signal items we're not keeping
  "predictions": [                                                           // 0-4 falsifiable, concrete, dated
    {
      "what": "concrete, falsifiable outcome — name the actor and artefact where possible",
      "by_when": "YYYY-MM-DD — when this should be judged; pick a date you'd actually bet on",
      "confidence": 0.0,                                                     // 0..1 calibrated — 0.5 = coin-flip
      "citations": [ "/author/status/id", ... ]                              // permalinks grounding the call
    }
  ]
}
Cite permalinks concretely. Concrete over generic. Never invent posts. No corporate speak.`;

  const body = top.map(p => `perma=${p.permalink} @${p.author} ${p.likes}♥ ${p.replies}💬 [tags:${p._tags.join(',')}] ${p.text.slice(0, 280).replace(/\n/g, ' ')}`).join('\n');

  let brief;
  try {
    const resp = await llm({ purpose: 'reasoning', system: synthSys, prompt: body });
    budget.llmCalls++; budget.tokensIn += resp.tokens?.input || 0; budget.tokensOut += resp.tokens?.output || 0; budget.costCents += resp.cost_cents || 0;
    brief = extractJson(resp.text);
    console.log(`\n[x-intel] ${bucketDef.id}: synthesized via ${resp.model_used} (${resp.tokens?.input}→${resp.tokens?.output} tok)`);
  } catch (e) {
    console.log(`\n[x-intel] ${bucketDef.id}: synthesis failed: ${e.message}`);
    continue;
  }

  const md = [
    `# ${bucketDef.label} — ${today}`,
    ``,
    `_Workspace: \`${workspace}\` · Bucket: \`${bucketDef.id}\` · ${top.length} posts analysed_`,
    ``,
    brief.headline ? `**Headline:** ${brief.headline}\n` : '',
    brief.highlights?.length ? `## Highlights\n${brief.highlights.map(b => `- ${b}`).join('\n')}\n` : '',
    brief.continuity?.length ? `## Continuity with prior briefs\n${brief.continuity.map(b => `- ${b}`).join('\n')}\n` : '',
    brief.emerging_patterns?.length ? `## Emerging patterns\n${brief.emerging_patterns.map(b => `- ${b}`).join('\n')}\n` : '',
    brief.watch_next?.length ? `## Watch next\n${brief.watch_next.map(b => `- ${b}`).join('\n')}\n` : '',
    brief.skip_list?.length ? `## Skipped\n${brief.skip_list.map(b => `- ${b}`).join('\n')}\n` : '',
    `---`,
    ``,
    `## Raw (top ${top.length})`,
    ``,
    ...top.map(p => `- **@${p.author}** (${p.likes}♥ ${p.replies}💬 · score=${p._score?.toFixed(2)}): ${p.text.slice(0, 260).replace(/\n/g, ' ')} ([link](https://x.com${p.permalink}))`),
  ].filter(Boolean).join('\n');

  const draftPath = `/tmp/x-intel-${bucketDef.id}-${today}.md`;
  fs.writeFileSync(draftPath, md);
  console.log(`  draft → ${draftPath} (${md.length} chars)`);

  const predictions = Array.isArray(brief.predictions) ? brief.predictions : [];
  const normalizedPredictions = predictions
    .filter(p => p && typeof p.what === 'string' && p.what.trim() && typeof p.by_when === 'string')
    .map(p => ({
      id: predictionId(bucketDef.id, p.what),
      what: p.what.trim(),
      by_when: p.by_when,
      confidence: typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
      citations: Array.isArray(p.citations) ? p.citations.slice(0, 6) : [],
      made_at: today,
    }));
  budget.predictionsEmitted += normalizedPredictions.length;

  appendHistory(workspace, {
    date: today,
    bucket: bucketDef.id,
    headline: brief.headline || '',
    emerging_patterns: brief.emerging_patterns || [],
    highlights: (brief.highlights || []).slice(0, 3),
    posts: top.length,
    predictions: normalizedPredictions,
  });

  const entry = propose({
    kind: 'knowledge_upload',
    summary: `${bucketDef.label} · ${today} · ${brief.headline || `${top.length} posts`}`,
    payload: {
      title: `${bucketDef.label} — ${today}`,
      filename: `x-intel-${bucketDef.id}-${today}.md`,
      body: md,
      replace: true, // idempotent: re-runs today replace today's doc
    },
    autoApproveAfter: bucketDef.auto_approve_after ?? 3,
  });
  console.log(`  approval: ${entry.status} · id=${entry.id.slice(0, 8)} · trust=${JSON.stringify(entry.trustStats)}`);
  if (entry.status === 'auto_applied') {
    try {
      const ing = await ingestKnowledgeFile(entry.payload);
      console.log(`  auto-uploaded → ${ing.uploaded?.[0]?.id}`);
      budget.uploads++; budget.autoApplied++;
    } catch (e) { console.log(`  auto-upload failed: ${e.message}`); }
  } else if (entry.status === 'pending') {
    budget.pending++;
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const accuracy = loadRollingAccuracy(workspace, 30);
const accLine = Object.keys(accuracy).length
  ? Object.entries(accuracy).map(([b, v]) => `${b}=${(v.acc * 100).toFixed(0)}% (n=${v.n})`).join(', ')
  : 'no scored predictions yet';
console.log('\n[x-intel] done');
console.log(`[x-intel] report: ${elapsed}s · ${budget.llmCalls} llm calls · ${budget.tokensIn} in / ${budget.tokensOut} out tok · ${(budget.costCents / 100).toFixed(3)} USD · ${budget.autoApplied} auto-uploaded · ${budget.pending} pending approval · ${budget.predictionsEmitted} predictions emitted`);
console.log(`[x-intel] forecast accuracy (30d): ${accLine}`);
browser.close();
