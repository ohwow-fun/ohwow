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
import {
  scrollAndHarvest,
  scrapeRepliers,
  loadSeen,
  appendSeen,
  filterPosts,
  buildEngagerRecord,
  writeEngagersSidecar,
} from './_x-harvest.mjs';
import { propose } from './_approvals.mjs';
import { formatClassifyLine, ENGAGER_CLASSIFIER_GUIDANCE } from './_x-classify.mjs';
import crypto from 'node:crypto';

function predictionId(bucketId, what) {
  return crypto.createHash('sha1').update(`${bucketId}::${what}`).digest('hex').slice(0, 16);
}

import { loadRollingAccuracy } from './_accuracy.mjs';

const DRY = process.env.DRY === '1';
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 5);
const BUCKET_FILTER = new Set((process.env.BUCKETS || '').split(',').map(s => s.trim()).filter(Boolean));
const SOURCE_FILTER = new Set((process.env.SOURCES || '').split(',').map(s => s.trim()).filter(Boolean));
const PROFILE = process.env.PROFILE || 'Profile 1';

function historyPath(workspace) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-intel-history.jsonl');
}

// Per-run sidecar of author candidates (handle, permalink, bucket, score, engagement).
// Downstream layer-4 writers (x-authors-to-crm.mjs) consume this instead of
// re-parsing the prose brief, so no LLM call is required to extract identity.
function authorsSidecarPath(workspace, date) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, `x-authors-${date}.jsonl`);
}

function writeAuthorsSidecar(workspace, date, records) {
  if (!records.length) return null;
  const p = authorsSidecarPath(workspace, date);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Overwrite rather than append: a same-day re-run re-synthesizes the same
  // top set, and we want the sidecar to match the run's final decision, not
  // accumulate duplicates.
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
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

// Engager surface: repliers on our own recent posts + repliers on
// configured competitor profiles' threads. Both are the "in-market by
// behavior" signal the rubric's engager boost was tuned for.
// We collect them into a single array so we can write the raw-harvest
// sidecar (x-engagers-<date>.jsonl) BEFORE filter/dedup/classify. The
// sidecar is the only end-to-end observability for this surface; without
// it, engager rows are only visible when they survive filter + pass
// classify, which masks whether the scrape itself produced rows.
const engagerRows = [];           // for queueing into allPosts (classifier input)
const engagerSidecarRows = [];    // for the raw-harvest sidecar (pre-filter)

const OWN_POST_ENGAGERS_ENABLED = process.env.OWN_POST_ENGAGERS !== '0';
if (OWN_POST_ENGAGERS_ENABLED && (!SOURCE_FILTER.size || SOURCE_FILTER.has('engagers'))) {
  let ownHandle = cfg.own_handle || null;
  if (!ownHandle) {
    try {
      ownHandle = await page.evaluate(`(() => {
        const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
        return link ? link.getAttribute('href').replace(/^\\//,'') : null;
      })()`);
    } catch { ownHandle = null; }
  }
  if (ownHandle) {
    console.log(`\n[x-intel] engagers for own-handle @${ownHandle}`);
    try {
      const ownPosts = await scrollAndHarvest(page, `https://x.com/${ownHandle}`, 2);
      const myPosts = ownPosts.filter(p => p.author === ownHandle && !p.isRetweet).slice(0, 3);
      console.log(`  found ${myPosts.length} own recent posts to scan for repliers`);
      for (const parent of myPosts) {
        try {
          const repliers = await scrapeRepliers(page, parent.permalink, 2);
          console.log(`  ${parent.permalink} → ${repliers.length} repliers`);
          for (const r of repliers) {
            if (!r.author || r.author === ownHandle) continue;
            engagerSidecarRows.push(buildEngagerRecord(r, 'engager:own-post', ownHandle, parent.permalink));
            engagerRows.push({
              ...r,
              _bucketHint: 'market_signal',
              _engagerSource: 'engager:own-post',
              _parentAuthor: ownHandle,
              _parentPermalink: parent.permalink,
            });
          }
        } catch (e) { console.log(`  ${parent.permalink} scrape failed: ${e.message}`); }
      }
    } catch (e) { console.log(`[x-intel] own-post engager scan failed: ${e.message}`); }
  } else {
    console.log('[x-intel] skipping own-post engagers (no own_handle resolvable)');
  }
}

// Competitor-thread engagers: config-gated per profile via
// sources.profiles[].harvest_engagers.
if (!SOURCE_FILTER.size || SOURCE_FILTER.has('engagers')) {
  for (const p of cfg.sources.profiles || []) {
    if (!p.harvest_engagers) continue;
    const parentPosts = Array.from(allPosts.values())
      .filter(x => x.author === p.handle)
      .slice(0, p.engager_parent_posts ?? 3);
    if (!parentPosts.length) continue;
    console.log(`\n[x-intel] engagers for @${p.handle} over ${parentPosts.length} recent posts`);
    for (const parent of parentPosts) {
      try {
        const repliers = await scrapeRepliers(page, parent.permalink, p.engager_max_scrolls ?? 3);
        console.log(`  ${parent.permalink} → ${repliers.length} repliers`);
        for (const r of repliers) {
          if (!r.author || r.author === p.handle) continue;
          const source = `engager:competitor:${p.handle}`;
          engagerSidecarRows.push(buildEngagerRecord(r, source, p.handle, parent.permalink));
          engagerRows.push({
            ...r,
            _bucketHint: 'market_signal',
            _engagerSource: source,
            _parentAuthor: p.handle,
            _parentPermalink: parent.permalink,
          });
        }
      } catch (e) { console.log(`  ${parent.permalink} scrape failed: ${e.message}`); }
    }
  }
}

// Write the raw-harvest sidecar before anything downstream mutates the
// row set. Covers both own-post and competitor surfaces. Empty runs skip
// the file write so we don't litter the workspace dir.
const engagerSidecarPath = writeEngagersSidecar(workspace, today, engagerSidecarRows);
if (engagerSidecarPath) {
  console.log(`[x-intel] engagers sidecar → ${engagerSidecarPath} (${engagerSidecarRows.length} rows)`);
} else {
  console.log('[x-intel] no engager rows harvested this run');
}

if (engagerRows.length) {
  addPosts(engagerRows, 'engagers');
  console.log(`[x-intel] +${engagerRows.length} engager rows queued for classification`);
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
const classifySysBase = `You classify X posts for this team: ${cfg.workspace_description}
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
  const body = batch.map((p, i) => formatClassifyLine(p, i)).join('\n');
  const classifySys = batch.some(p => p._engagerSource)
    ? classifySysBase + ENGAGER_CLASSIFIER_GUIDANCE
    : classifySysBase;
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

// Authors sidecar is the cheap, LLM-free output of this run — a flat
// list of (handle, bucket, score, engagement) rows that x-authors-to-crm
// consumes downstream. Build it from the classified posts BEFORE the
// DRY gate so DRY runs still populate the funnel. Synthesis (LLM brief
// + prediction extraction) stays gated behind DRY because that's where
// the spend lives.
const authorCandidates = [];
for (const bucketDef of cfg.buckets) {
  if (BUCKET_FILTER.size && !BUCKET_FILTER.has(bucketDef.id)) continue;
  const posts = byBucket[bucketDef.id] || [];
  const top = posts.slice(0, cfg.budget?.max_posts_synthesized_per_bucket ?? 25);
  for (const p of top) {
    if (!p.author || !p.permalink) continue;
    authorCandidates.push({
      handle: p.author,
      display_name: p.displayName || null,
      permalink: p.permalink,
      bucket: bucketDef.id,
      score: typeof p._score === 'number' ? p._score : null,
      likes: p.likes ?? 0,
      replies: p.replies ?? 0,
      tags: p._tags || [],
      // Propagate the engager source so x-authors-to-crm tags the
      // ledger row with 'engager:competitor:<handle>' (or 'engager:
      // own-post' once own-post harvest is wired), which triggers the
      // rubric's engager boost.
      __source: p._engagerSource || 'sidecar',
      first_seen_ts: new Date().toISOString(),
    });
  }
}
const sidecarPathDry = writeAuthorsSidecar(workspace, today, authorCandidates);
if (sidecarPathDry) console.log(`[x-intel] authors sidecar → ${sidecarPathDry} (${authorCandidates.length} rows)`);

// Posts sidecar — full text + permalink for the top N posts per bucket.
// x-reply consumes this to target replies. Kept separate from the
// authors sidecar because the row shape is wider (text is the
// expensive field) and downstream reply scoring wants to avoid a re-
// scrape.
const postsSidecar = [];
for (const bucketDef of cfg.buckets) {
  if (BUCKET_FILTER.size && !BUCKET_FILTER.has(bucketDef.id)) continue;
  const posts = byBucket[bucketDef.id] || [];
  const top = posts.slice(0, cfg.budget?.max_posts_synthesized_per_bucket ?? 25);
  for (const p of top) {
    if (!p.permalink) continue;
    postsSidecar.push({
      permalink: p.permalink,
      author: p.author,
      display_name: p.displayName || null,
      bucket: bucketDef.id,
      text: (p.text || '').slice(0, 600),
      score: p._score ?? null,
      tags: p._tags || [],
      likes: p.likes ?? 0,
      replies: p.replies ?? 0,
      first_seen_ts: new Date().toISOString(),
    });
  }
}
if (postsSidecar.length) {
  const postsPath = path.join(os.homedir(), '.ohwow', 'workspaces', workspace, `x-posts-${today}.jsonl`);
  fs.mkdirSync(path.dirname(postsPath), { recursive: true });
  fs.writeFileSync(postsPath, postsSidecar.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[x-intel] posts sidecar → ${postsPath} (${postsSidecar.length} rows)`);
}

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

// Sidecar was already written above the DRY gate so the author funnel
// works in both DRY and live runs.

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const accuracy = loadRollingAccuracy(workspace, 30);
const accLine = Object.keys(accuracy).length
  ? Object.entries(accuracy).map(([b, v]) => `${b}=${(v.acc * 100).toFixed(0)}% (n=${v.n})`).join(', ')
  : 'no scored predictions yet';
console.log('\n[x-intel] done');
console.log(`[x-intel] report: ${elapsed}s · ${budget.llmCalls} llm calls · ${budget.tokensIn} in / ${budget.tokensOut} out tok · ${(budget.costCents / 100).toFixed(3)} USD · ${budget.autoApplied} auto-uploaded · ${budget.pending} pending approval · ${budget.predictionsEmitted} predictions emitted`);
console.log(`[x-intel] forecast accuracy (30d): ${accLine}`);
browser.close();
