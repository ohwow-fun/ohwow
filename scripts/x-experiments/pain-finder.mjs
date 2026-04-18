#!/usr/bin/env node
/**
 * pain-finder — discover posts from operators describing a genuine pain,
 * classify them, draft a reply that would actually help, emit a review doc.
 *
 * Scope: standalone, read-only. Does NOT post, does NOT write to ohwow's
 * approval queue, does NOT touch the CRM or daemon state. The whole point
 * of this script is to iterate on query seeds + classifier rubric + draft
 * prompt in a closed loop until the top-10 picks are posts worth replying
 * to. Fold-back into reply-target-selector.ts is a follow-up plan.
 *
 * Flow per run:
 *   1. Spawn / attach to the authenticated Chrome profile (reuses
 *      _x-browser.mjs + _x-harvest.mjs).
 *   2. For each query in pain-finder-queries.json:
 *      - If platform in {x, both}: scrape x.com/search?q=<q>&f=live.
 *      - If platform in {threads, both}: scrape threads.com/search?q=<q>.
 *   3. Deterministic filters: dedup by permalink, drop retweets / replies /
 *      too-old / too-crowded / obviously-promo posts.
 *   4. LLM classifier (Haiku-class) per survivor. Keep only `genuine_pain`
 *      with `sellerish <= 1`.
 *   5. Score by severity + specificity + recency, minus sellerish.
 *   6. Top-N go to the drafter (Sonnet). Drafts pass through an inline
 *      voice gate (port of src/lib/voice/voice-core.ts). Failures skip.
 *   7. Write two artifacts:
 *        ~/.ohwow/experiments/pain-finder/<ts>.jsonl — full per-candidate records
 *        ~/.ohwow/experiments/pain-finder/<ts>.md    — top-10 human review doc
 *
 * Env knobs:
 *   PLATFORM=x|threads|both   (default: both)
 *   LIMIT=30                  max candidates per query to consider
 *   TOPN=10                   how many to draft replies for
 *   MAX_SCROLLS=4             scroll passes per query
 *   QUERIES_FILE=...          override path (relative to repo root)
 *   PROMPTS_FILE=...          override path
 *   ONLY_DOMAIN=<domain>      run only queries in one pain domain
 *   DRY=1                     (forced true; flag is illustrative)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RawCdpBrowser } from '../../src/execution/browser/raw-cdp.ts';
import { ensureXReady, openFreshXTab } from './_x-browser.mjs';
import { llm, resolveOhwow, extractJson } from './_ohwow.mjs';
import { scrollAndHarvest } from './_x-harvest.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const QUERIES_FILE = process.env.QUERIES_FILE
  ? path.resolve(process.env.QUERIES_FILE)
  : path.join(REPO_ROOT, 'scripts/x-experiments/pain-finder-queries.json');
const PROMPTS_FILE = process.env.PROMPTS_FILE
  ? path.resolve(process.env.PROMPTS_FILE)
  : path.join(REPO_ROOT, 'scripts/x-experiments/pain-finder-prompts.md');

const PLATFORM = (process.env.PLATFORM || 'both').toLowerCase();
const LIMIT = Number(process.env.LIMIT || 30);
const TOPN = Number(process.env.TOPN || 10);
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 4);
const ONLY_DOMAIN = process.env.ONLY_DOMAIN || null;

// Single-query test mode. Lets you try one query at a time to tune
// semantics without committing it to the queries file. Set QUERY="..."
// and optionally DOMAIN=... to override the queries file entirely. In
// this mode the .md shows ALL classifier verdicts (not just drafted
// top-N) so you can see raw signal.
const INLINE_QUERY = process.env.QUERY || null;
const INLINE_DOMAIN = process.env.DOMAIN || 'inline';
const INLINE_X_EXTRA = process.env.X_EXTRA || 'lang:en -filter:replies';
const SKIP_DRAFTS = process.env.SKIP_DRAFTS === '1';

// Classifier mode:
//   SKIP_CLASSIFIER=1         → no LLM labeling (fast, raw post review)
//   CLASSIFIER_CONCURRENCY=N  → parallel classifier calls, default 8
// In inline-query mode the classifier is skipped by default because
// we're judging *query semantics*, not filtering. Opt back in with
// CLASSIFY=1 when we want LLM verdicts on an inline query.
const SKIP_CLASSIFIER = process.env.SKIP_CLASSIFIER === '1'
  || (INLINE_QUERY && process.env.CLASSIFY !== '1');
const CLASSIFIER_CONCURRENCY = Number(process.env.CLASSIFIER_CONCURRENCY || 8);

// Recency. RECENCY is a window like "24h", "2d", "3d". Drives both the
// X within_time: operator and the post-scrape maxAgeHours filter so the
// two stay aligned.
const RECENCY = process.env.RECENCY || '2d';
function recencyToHours(r) {
  const m = String(r).match(/^(\d+)\s*(h|d)$/i);
  if (!m) return 48;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'd' ? n * 24 : n;
}
function recencyToXOperator(r) {
  const m = String(r).match(/^(\d+)\s*(h|d)$/i);
  if (!m) return 'within_time:2d';
  return `within_time:${m[1]}${m[2].toLowerCase()}`;
}
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || recencyToHours(RECENCY) + 4);
// Viral piggyback: widen the age window since f=top returns posts that
// often spanned 7-14 days but still have live reply activity.
const X_RECENCY_OP = recencyToXOperator(RECENCY);
const HIGH_ENG_MAX_AGE_HOURS = Number(process.env.HIGH_ENG_MAX_AGE_HOURS || 14 * 24);

// Engagement mode switch. Each query in queries.json declares `mode: "direct"`
// or `mode: "viral"`. The env var HIGH_ENGAGEMENT=1 forces viral for inline
// single-query mode. Per-query overrides (min_likes, min_replies, max_age_hours)
// win over the mode preset.
const HIGH_ENGAGEMENT = process.env.HIGH_ENGAGEMENT === '1';
const INLINE_MODE = HIGH_ENGAGEMENT ? 'viral' : 'direct';
const DIRECT_FILTERS = {
  maxLikes: 500,
  maxReplies: 40,
  minLikes: 0,
  minReplies: 0,
  maxAgeHours: MAX_AGE_HOURS,
  minTextLength: 25,
  maxCapsRatio: 0.45,
};
const VIRAL_FILTERS = {
  maxLikes: Number.POSITIVE_INFINITY,
  maxReplies: Number.POSITIVE_INFINITY,
  minLikes: Number(process.env.MIN_LIKES || 50),
  minReplies: Number(process.env.MIN_REPLIES || 10),
  maxAgeHours: HIGH_ENG_MAX_AGE_HOURS,
  minTextLength: 25,
  maxCapsRatio: 0.45,
};

/** Compute the active filter set for a given query, respecting mode + overrides. */
function filtersFor(queryDef) {
  const mode = queryDef.mode || (HIGH_ENGAGEMENT ? 'viral' : 'direct');
  const base = mode === 'viral' ? VIRAL_FILTERS : DIRECT_FILTERS;
  return {
    ...base,
    ...(queryDef.min_likes != null ? { minLikes: Number(queryDef.min_likes) } : {}),
    ...(queryDef.min_replies != null ? { minReplies: Number(queryDef.min_replies) } : {}),
    ...(queryDef.max_age_hours != null ? { maxAgeHours: Number(queryDef.max_age_hours) } : {}),
    mode,
  };
}

/** Author dedup: at most MAX_PER_AUTHOR posts per author per run. */
const MAX_PER_AUTHOR = Number(process.env.MAX_PER_AUTHOR || 1);

// ---------------------------------------------------------------------------
// Inline anti-pitch filter (port of the critical parts of reply-target-selector.ts)
// ---------------------------------------------------------------------------

const PITCH_PATTERNS = [
  'dm me', "dm'd me", 'link in bio', 'link below', 'check my bio',
  'comment "', "comment '", 'follow for', 'follow me for',
  'pre-order', 'preorder', 'promo code', 'coupon code',
  'sign up at', 'sign-up',
  'limited time', 'limited spots', 'only 24 hours',
  'use code', 'affiliate',
  'free pdf', 'free ebook', 'free training',
  'giveaway', 'giving away',
  'defi', 'memecoin', 'altcoin', 'presale', 'pre-sale',
  'airdrop', 'moonshot', 'ico ', 'nft', 'web3', 'onchain', 'on-chain',
  'staking', 'play to earn', 'p2e',
  'i will set up', 'i will build', 'i will create',
  "i'll set up", "i'll build", "i'll create",
  'dm to order', 'order now',
  '🚀🚀', '💰', '🔥🔥', '👇👇',
  // pain-finder-specific: these strings often appear in AI product pitches
  'i built an', 'we built', 'we shipped', 'just launched', 'just shipped',
  '🧵', '(a thread)', 'a thread 👇',
];

const PITCH_REGEXES = [
  { re: /(?:^|\s)\$[A-Z]{2,12}(?![A-Za-z0-9])/g, weight: 2 },      // $TICKER
  { re: /#\w+[\s\S]*?#\w+[\s\S]*?#\w+/, weight: 1 },                // multi-hashtag
  { re: /\d+\s+(?:hours?|mins?|minutes?|days?)\s+left\b/i, weight: 1 },
  { re: /\b[A-Z]{2,}(?:\s+[A-Z]{2,}){3,}/, weight: 1 },
  { re: /^i (?:will|can|'ll)\s+(?:set up|build|create|deliver|design|configure)/i, weight: 2 },
];

function capsRatio(text) {
  const letters = text.match(/[A-Za-z]/g);
  if (!letters || letters.length < 10) return 0;
  const caps = text.match(/[A-Z]/g);
  return (caps?.length || 0) / letters.length;
}

function antiPitchFilter(post, filters) {
  const text = (post.text || '').toLowerCase();
  if (!post.text || post.text.length < filters.minTextLength) return 'textTooShort';
  if (post.isRetweet) return 'retweet';
  if (post.replyingTo) return 'reply';
  if ((post.likes ?? 0) > filters.maxLikes) return `likesTooHigh(${post.likes})`;
  if ((post.replies ?? 0) > filters.maxReplies) return `repliesTooHigh(${post.replies})`;
  if ((post.likes ?? 0) < filters.minLikes) return `likesTooLow(${post.likes})`;
  if ((post.replies ?? 0) < filters.minReplies) return `repliesTooLow(${post.replies})`;
  if (post.datetime) {
    const posted = Date.parse(post.datetime);
    if (!isNaN(posted)) {
      const hours = (Date.now() - posted) / 3_600_000;
      if (hours > filters.maxAgeHours) return `tooOld(${hours.toFixed(1)}h)`;
    }
  }
  const caps = capsRatio(post.text || '');
  if (caps >= filters.maxCapsRatio) return `tooShouty(${(caps * 100).toFixed(0)}%)`;
  let pitchWeight = 0;
  for (const p of PITCH_PATTERNS) if (text.includes(p)) pitchWeight++;
  for (const { re, weight } of PITCH_REGEXES) {
    const m = (post.text || '').match(re);
    if (m) pitchWeight += m.length * weight;
  }
  if (pitchWeight >= 2) return `pitchy(weight=${pitchWeight})`;
  return null;
}

// ---------------------------------------------------------------------------
// Inline voice gate (port of src/lib/voice/voice-core.ts voiceCheck)
// ---------------------------------------------------------------------------

// `\bus\b/i` used to false-positive on "US" (country), e.g. "US customers"
// is legitimate copy. Drop the /i flag on "us" specifically — lowercase
// "us" is the first-person pronoun, uppercase "US" is a country code.
const FIRST_PERSON = [
  /\bI\b/, /\bI'(?:ve|m|d|ll|s|re)\b/i, /\bme\b/i, /\bmy\b/i, /\bmine\b/i,
  /\bwe\b/i, /\bus\b/, /\bour\b/i,
];
const FAKE_EXPERIENCE = [
  /\byou end up\b/i, /\byou (?:find|found)\b/i,
  /\bin (?:my|our) experience\b/i, /\bwhen (?:you|i) tr(?:y|ied)\b/i,
];
const SOFTENERS = [
  'great take', 'this is interesting', 'happy to',
  'at the end of the day', 'table stakes', 'the real question is',
  "here's the thing", 'the key is',
];
const SIGN_OFFS = ['thanks!', 'cheers', 'best,', 'hope this helps'];
const CRINGE = [
  /\bera\b(?!\s*of\s)/i, /is this mid\b/i,
  /\bnot me (?:\w+ing)\b/i, /\bvibes?\s+check\b/i,
  /💀|😭(?!\w)/,
];

/**
 * Auto-fix cosmetic violations the drafter repeatedly commits (trailing
 * period, em-dash/en-dash) so they don't kill otherwise-publishable
 * drafts. Only applied BEFORE voiceCheck — the real violations (first
 * person, product names, softeners) still hard-fail.
 *
 * Em-dash replacement: ", " reads naturally in most clause-joining
 * contexts and is safer than "; " which looks stiff on X/Threads.
 */
function autoFixCosmetic(text) {
  if (!text) return text;
  let t = text;
  // Replace em-dash and en-dash with ", ". Strip duplicate spaces that
  // result when the original had " — " (space-dash-space).
  t = t.replace(/\s*[—–]\s*/g, ', ');
  // Strip a single trailing period (and any whitespace after it).
  t = t.replace(/\.\s*$/, '');
  // Collapse doubled commas/spaces that the replacement might create.
  t = t.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
  return t;
}

function voiceCheck(text, platform, useCase) {
  const reasons = [];
  const caps = { x: { reply: 240, post: 280 }, threads: { reply: 280, post: 500 } };
  const cap = caps[platform][useCase];
  if (text.length > cap) reasons.push(`length(${text.length}>${cap})`);
  if (/—|–/.test(text)) reasons.push('emDash');
  if (/\bplease\b/i.test(text)) reasons.push('please');
  if (/#\w/.test(text)) reasons.push('hashtag');
  if (/\bhttps?:\/\//.test(text)) reasons.push('link');
  if (/\.\s*$/.test(text)) reasons.push('trailingPeriod');
  for (const re of FIRST_PERSON) if (re.test(text)) { reasons.push('firstPerson'); break; }
  for (const re of FAKE_EXPERIENCE) if (re.test(text)) { reasons.push('fakeExperience'); break; }
  for (const re of CRINGE) if (re.test(text)) { reasons.push('cringe'); break; }
  const lower = text.toLowerCase();
  for (const s of SOFTENERS) if (lower.includes(s)) { reasons.push(`softener:${s}`); break; }
  for (const s of SIGN_OFFS) if (lower.includes(s)) { reasons.push(`signoff:${s}`); break; }
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Threads-specific harvest (no shared _threads-harvest helper exists yet)
// ---------------------------------------------------------------------------

const THREADS_HARVEST_JS = `(() => {
  // Threads uses role=article wrappers. Each post is inside a container
  // with a link pattern /@handle/post/<shortcode>.
  const articles = Array.from(document.querySelectorAll('div[data-pressable-container="true"], div[role="article"]'));
  const seen = new Set();
  const out = [];
  for (const a of articles) {
    const postLink = a.querySelector('a[href*="/post/"][href^="/@"]');
    if (!postLink) continue;
    const permalink = postLink.getAttribute('href');
    if (seen.has(permalink)) continue;
    seen.add(permalink);
    const handleMatch = permalink.match(/^\\/(@[^/]+)\\/post/);
    const handle = handleMatch ? handleMatch[1] : null;
    // Body text: largest text node inside the container
    const textEls = Array.from(a.querySelectorAll('div[dir="auto"]'));
    let text = '';
    for (const t of textEls) {
      const s = (t.innerText || '').trim();
      if (s.length > text.length) text = s;
    }
    // Timestamp
    const time = a.querySelector('time');
    const datetime = time?.getAttribute('datetime') || null;
    // Engagement — Threads uses aria-label on action buttons ("12 likes")
    const labels = Array.from(a.querySelectorAll('[aria-label]')).map(x => x.getAttribute('aria-label') || '');
    const likeLabel = labels.find(l => /\\blikes?\\b/i.test(l));
    const replyLabel = labels.find(l => /\\breplies\\b/i.test(l) || /\\bcomments?\\b/i.test(l));
    const num = (s) => {
      if (!s) return 0;
      const m = String(s).replace(/[,\\s]/g, '').match(/([\\d.]+)([kKmM]?)/);
      if (!m) return 0;
      const n = parseFloat(m[1]);
      const mult = m[2]?.toLowerCase() === 'k' ? 1e3 : m[2]?.toLowerCase() === 'm' ? 1e6 : 1;
      return Math.round(n * mult);
    };
    out.push({
      permalink,
      author: handle,
      text,
      datetime,
      likes: num(likeLabel),
      replies: num(replyLabel),
      reposts: 0,
      isRetweet: false,
      replyingTo: false,
      lang: null,
      platform: 'threads',
    });
  }
  return out;
})()`;

async function threadsScrollAndHarvest(page, url, maxScrolls = 4) {
  await page.goto(url);
  await new Promise(r => setTimeout(r, 3200));
  const seen = new Map();
  let stagnant = 0;
  for (let i = 0; i < maxScrolls; i++) {
    let batch = [];
    try { batch = await page.evaluate(THREADS_HARVEST_JS); } catch { /* ignore */ }
    const before = seen.size;
    for (const p of (batch || [])) {
      if (p.permalink && !seen.has(p.permalink)) seen.set(p.permalink, p);
    }
    const gained = seen.size - before;
    if (gained === 0) stagnant++; else stagnant = 0;
    if (stagnant >= 3) break;
    try { await page.pressKey('End'); } catch {}
    try { await page.evaluate('window.scrollBy(0, window.innerHeight * 1.8)'); } catch {}
    await new Promise(r => setTimeout(r, 1400));
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scorePost(post, verdict) {
  const bd = {};
  bd.severity = (verdict.severity || 0) * 10;
  bd.specificity = (verdict.specificity || 0) * 8;
  bd.sellerishPenalty = -(verdict.sellerish || 0) * 20;
  // recency: decays linearly across the active window (MAX_AGE_HOURS).
  // A 20-pt max weight makes recency matter more than before — the user
  // explicitly wanted the freshest posts surfaced first.
  if (post.datetime) {
    const posted = Date.parse(post.datetime);
    if (!isNaN(posted)) {
      const hours = (Date.now() - posted) / 3_600_000;
      const decay = Math.max(0, 1 - hours / Math.max(1, MAX_AGE_HOURS));
      bd.recency = Math.round(decay * 20 * 10) / 10;
    }
  }
  if ((post.replies ?? 0) > 0) bd.replyPenalty = -Math.min(10, (post.replies || 0) * 0.4);
  const score = Object.values(bd).reduce((a, b) => a + b, 0);
  return { score: Math.round(score * 10) / 10, breakdown: bd };
}

// ---------------------------------------------------------------------------
// LLM classifier + drafter
// ---------------------------------------------------------------------------

function loadPrompts() {
  const raw = fs.readFileSync(PROMPTS_FILE, 'utf8');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10);
  const parts = raw.split(/^##\s+/m);
  const classifier = parts.find(p => /^Classifier prompt/i.test(p)) || '';
  const drafter = parts.find(p => /^Drafter prompt/i.test(p)) || '';
  const viralDrafter = parts.find(p => /^Viral piggyback drafter prompt/i.test(p)) || drafter;
  return { classifier, drafter, viralDrafter, hash };
}

async function classifyPost(post, prompts) {
  const system = prompts.classifier;
  const user = [
    `POST AUTHOR: ${post.author || 'unknown'}`,
    `POST TEXT:`,
    `"""`,
    (post.text || '').slice(0, 1200),
    `"""`,
    ``,
    `Output JSON only.`,
  ].join('\n');
  try {
    const r = await llm({
      purpose: 'simple_classification',
      system,
      prompt: user,
      prefer_model: 'claude-haiku-4-5',
      max_tokens: 300,
    });
    const text = r?.text || '';
    return extractJson(text);
  } catch (e) {
    return { class: 'error', error: String(e.message || e).slice(0, 200) };
  }
}

async function draftReply(post, verdict, prompts, platform) {
  const isViral = verdict.class === 'viral_piggyback' || post.mode === 'viral';
  const system = isViral ? prompts.viralDrafter : prompts.drafter;
  const user = [
    `PLATFORM: ${platform}`,
    `POST AUTHOR: ${post.author || 'unknown'}`,
    isViral ? `ENGAGEMENT: ${post.likes ?? 0} likes, ${post.replies ?? 0} replies (reply crowd is the target)` : `POST PAIN DOMAIN (classifier-labeled): ${verdict.pain_domain || 'unspecified'}`,
    `POST TEXT:`,
    `"""`,
    (post.text || '').slice(0, 1200),
    `"""`,
    ``,
    `Write the reply. Output JSON only.`,
  ].join('\n');
  try {
    const r = await llm({
      purpose: 'generation',
      system,
      prompt: user,
      prefer_model: 'claude-sonnet-4-6',
      max_tokens: 600,
    });
    const text = r?.text || '';
    return extractJson(text);
  } catch (e) {
    return { draft: '', alternates: [], rationale: `error: ${String(e.message || e).slice(0, 200)}` };
  }
}

// ---------------------------------------------------------------------------
// Harvest driver
// ---------------------------------------------------------------------------

async function harvestXForQuery(page, queryDef) {
  // Mode drives tab + recency window:
  //   direct → f=live + RECENCY window (fresh 1:1 replies)
  //   viral  → f=top  + 14d window (top-tier engagement spans days)
  const mode = queryDef.mode || (HIGH_ENGAGEMENT ? 'viral' : 'direct');
  const tab = mode === 'viral' ? 'top' : 'live';
  const recencyOp = mode === 'viral' ? 'within_time:14d' : X_RECENCY_OP;
  const extras = [queryDef.x_extra, recencyOp].filter(Boolean).join(' ');
  const base = `https://x.com/search?q=${encodeURIComponent(queryDef.q + ' ' + extras)}&f=${tab}`;
  const rows = await scrollAndHarvest(page, base, MAX_SCROLLS);
  return rows.map(r => ({ ...r, platform: 'x', source_query: queryDef.q, domain: queryDef.domain, mode }));
}

async function harvestThreadsForQuery(page, queryDef) {
  const base = `https://www.threads.com/search?q=${encodeURIComponent(queryDef.q)}&serp_type=default`;
  const rows = await threadsScrollAndHarvest(page, base, MAX_SCROLLS);
  return rows.map(r => ({ ...r, platform: 'threads', source_query: queryDef.q, domain: queryDef.domain }));
}

// ---------------------------------------------------------------------------
// Output writers
// ---------------------------------------------------------------------------

function runOutputPaths() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(os.homedir(), '.ohwow', 'experiments', 'pain-finder');
  fs.mkdirSync(dir, { recursive: true });
  return {
    jsonl: path.join(dir, `${ts}.jsonl`),
    md: path.join(dir, `${ts}.md`),
    ts,
  };
}

function writeMd(records, outPath, meta) {
  // In inline-query mode, show ALL keepers (no top-N cap) with no draft
  // blocks — the goal is to judge query semantics, not reply quality.
  const top = meta.inlineQuery ? records : records.slice(0, TOPN);
  const lines = [];
  lines.push(`# pain-finder run — ${meta.ts}`);
  lines.push('');
  lines.push(`- platform: \`${meta.platform}\` · recency: \`${meta.recency}\` (maxAge=${meta.maxAgeHours}h)`);
  lines.push(`- queries: ${meta.queryCount}, harvested: ${meta.harvestedCount}, survived filters: ${meta.filteredCount}, genuine_pain: ${meta.keptCount}, top drafted: ${top.length}`);
  lines.push(`- prompts hash: \`${meta.promptsHash}\``);
  lines.push(`- queries file: \`${meta.queriesFile}\``);
  lines.push('');
  if (meta.perQuery && meta.perQuery.length) {
    lines.push(`## Per-query harvest`);
    lines.push('');
    lines.push('| domain | query | platform | raw | filtered | kept |');
    lines.push('|---|---|---|---:|---:|---:|');
    for (const q of meta.perQuery) {
      lines.push(`| ${q.domain} | \`${q.q}\` | ${q.platform} | ${q.raw} | ${q.filtered} | ${q.kept} |`);
    }
    lines.push('');
  }
  if (!top.length) {
    lines.push('_No candidates survived classification. Tune the queries or relax filters._');
    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    return;
  }
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const url = r.platform === 'x'
      ? (r.permalink?.startsWith('http') ? r.permalink : `https://x.com${r.permalink}`)
      : `https://www.threads.com${r.permalink}`;
    lines.push(`---`);
    lines.push('');
    lines.push(`## ${i + 1}. [${r.platform}] ${r.author || '??'} — score ${r.score} — domain ${r.verdict?.pain_domain || r.domain}`);
    lines.push('');
    lines.push(`**Link:** ${url}`);
    lines.push(`**When:** ${r.datetime || '?'} · **Likes:** ${r.likes ?? 0} · **Replies:** ${r.replies ?? 0}`);
    lines.push('');
    lines.push(`**Post:**`);
    lines.push('> ' + (r.text || '').replace(/\n/g, '\n> '));
    lines.push('');
    lines.push(`**Classifier:** class=\`${r.verdict?.class}\` severity=${r.verdict?.severity} specificity=${r.verdict?.specificity} sellerish=${r.verdict?.sellerish}`);
    lines.push(`> ${r.verdict?.rationale || ''}`);
    lines.push('');
    if (!r.draft) {
      // inline-query mode or SKIP_DRAFTS: no draft block
    } else if (r.draft?.draft) {
      lines.push(`**Drafted reply** ${r.voiceOk ? '✓ voice-gate-ok' : `✗ voice-gate: ${(r.voiceReasons || []).join(',')}`}:`);
      lines.push('');
      lines.push('```');
      lines.push(r.draft.draft);
      lines.push('```');
      if (r.draft.alternates?.length) {
        lines.push('');
        lines.push(`_Alternates:_`);
        for (const a of r.draft.alternates) lines.push(`- ${a}`);
      }
      if (r.draft.rationale) {
        lines.push('');
        lines.push(`_Rationale:_ ${r.draft.rationale}`);
      }
    } else {
      lines.push(`_No draft produced (${r.draft?.rationale || 'empty'})._`);
    }
    lines.push('');
    lines.push(`_Score breakdown: ${JSON.stringify(r.breakdown)}_`);
    lines.push('');
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const prompts = loadPrompts();
  let queries;
  if (INLINE_QUERY) {
    // single-query test mode — bypass queries file entirely
    queries = [{ domain: INLINE_DOMAIN, q: INLINE_QUERY, x_extra: INLINE_X_EXTRA }];
  } else {
    const queriesRaw = JSON.parse(fs.readFileSync(QUERIES_FILE, 'utf8'));
    queries = queriesRaw.queries;
    if (ONLY_DOMAIN) queries = queries.filter(q => q.domain === ONLY_DOMAIN);
    if (!queries.length) {
      console.error(`[pain-finder] no queries matched (ONLY_DOMAIN=${ONLY_DOMAIN || '-'})`);
      process.exit(2);
    }
  }

  const { workspace } = resolveOhwow();
  console.log(`[pain-finder] workspace=${workspace} platform=${PLATFORM} queries=${queries.length} prompts=${prompts.hash} recency=${RECENCY} maxAge=${MAX_AGE_HOURS}h`);

  const { browser } = await ensureXReady();

  // We re-use a single fresh tab for all harvesting. Threads and x.com
  // share the profile context, so navigation across them works.
  const page = await openFreshXTab(browser);

  // --- harvest ---
  const rawByPermalink = new Map();
  const perQuery = [];
  for (const q of queries) {
    if (PLATFORM === 'x' || PLATFORM === 'both') {
      try {
        const rows = await harvestXForQuery(page, q);
        let added = 0;
        for (const r of rows) if (r.permalink && !rawByPermalink.has(`x:${r.permalink}`)) { rawByPermalink.set(`x:${r.permalink}`, r); added++; }
        perQuery.push({ domain: q.domain, q: q.q, platform: 'x', raw: rows.length, added });
        console.log(`[x]       "${q.q}" → +${rows.length} (domain=${q.domain})`);
      } catch (e) {
        perQuery.push({ domain: q.domain, q: q.q, platform: 'x', raw: 0, added: 0, error: true });
        console.error(`[x]       "${q.q}" FAILED: ${e.message?.slice(0, 160)}`);
      }
    }
    if (PLATFORM === 'threads' || PLATFORM === 'both') {
      try {
        const rows = await harvestThreadsForQuery(page, q);
        let added = 0;
        for (const r of rows) if (r.permalink && !rawByPermalink.has(`th:${r.permalink}`)) { rawByPermalink.set(`th:${r.permalink}`, r); added++; }
        perQuery.push({ domain: q.domain, q: q.q, platform: 'threads', raw: rows.length, added });
        console.log(`[threads] "${q.q}" → +${rows.length} (domain=${q.domain})`);
      } catch (e) {
        perQuery.push({ domain: q.domain, q: q.q, platform: 'threads', raw: 0, added: 0, error: true });
        console.error(`[threads] "${q.q}" FAILED: ${e.message?.slice(0, 160)}`);
      }
    }
  }

  const harvested = Array.from(rawByPermalink.values());
  console.log(`[pain-finder] harvested=${harvested.length} unique posts across platforms`);

  // --- filter: per-query filter set based on the query's mode ---
  const queryByKey = new Map();
  for (const q of queries) queryByKey.set(q.q, q);

  const filtered = [];
  const rejected = [];
  for (const p of harvested) {
    const qDef = queryByKey.get(p.source_query) || { mode: (HIGH_ENGAGEMENT ? 'viral' : 'direct') };
    const filters = filtersFor(qDef);
    const reason = antiPitchFilter(p, filters);
    if (reason) rejected.push({ ...p, reject_reason: reason });
    else filtered.push(p);
  }

  // Author dedup: at most MAX_PER_AUTHOR posts per author per run.
  // Prevents a single high-performer (e.g. siddharthwv in "quit my 9-5"
  // testing) from monopolizing the harvest.
  filtered.sort((a, b) => (Date.parse(b.datetime || '') || 0) - (Date.parse(a.datetime || '') || 0));
  const byAuthor = new Map();
  const authorDeduped = [];
  const authorDropped = [];
  for (const p of filtered) {
    const key = (p.author || 'unknown').toLowerCase();
    const seen = byAuthor.get(key) || 0;
    if (seen >= MAX_PER_AUTHOR) { authorDropped.push(p); continue; }
    byAuthor.set(key, seen + 1);
    authorDeduped.push(p);
  }

  const rejectCounts = {};
  for (const r of rejected) {
    const tag = r.reject_reason.replace(/\(.*\)/, '');
    rejectCounts[tag] = (rejectCounts[tag] || 0) + 1;
  }
  const rejectSummary = Object.entries(rejectCounts).sort((a,b) => b[1] - a[1]).map(([k,v]) => `${k}:${v}`).join(' ');
  console.log(`[pain-finder] after anti-pitch filter: kept=${filtered.length} dropped=${rejected.length}${rejectSummary ? '  reasons: ' + rejectSummary : ''}`);
  console.log(`[pain-finder] author dedup: kept=${authorDeduped.length} droppedDupes=${authorDropped.length} (maxPerAuthor=${MAX_PER_AUTHOR})`);

  // classifier budget: cap post-dedup to keep LLM cost sane, prefer freshest
  const classifyBudget = Math.min(authorDeduped.length, LIMIT * 3);
  const toClassify = authorDeduped.slice(0, classifyBudget);

  // --- classify ---
  const classified = [];
  if (SKIP_CLASSIFIER) {
    // Raw mode: skip LLM labeling, mark every filtered post as keeper
    // so writeMd emits the full list for human eyeballing. Scoring uses
    // a neutral verdict so sorting still works by recency + replyPenalty.
    for (const p of toClassify) {
      const neutralVerdict = { class: 'unclassified', pain_domain: null, severity: 0, specificity: 0, sellerish: 0, rationale: '(skipped)' };
      const { score, breakdown } = scorePost(p, neutralVerdict);
      classified.push({ ...p, verdict: neutralVerdict, score, breakdown, kept: true });
    }
    console.log(`[pain-finder] classifier: SKIPPED (raw mode) — kept=${classified.length}`);
  } else {
    // Split by mode: viral piggyback posts skip the classifier entirely —
    // the engagement floor + viral-topic phrase already confirm the reply
    // audience is ICP. Direct-mode posts go through the classifier.
    const viralPosts = toClassify.filter(p => p.mode === 'viral');
    const directPosts = toClassify.filter(p => p.mode !== 'viral');

    for (const p of viralPosts) {
      const verdict = {
        class: 'viral_piggyback',
        pain_domain: p.domain || null,
        severity: 2,
        specificity: 2,
        sellerish: 0,
        rationale: '(viral mode — engagement filter + phrase gate passed, skipping classifier)',
      };
      const { score, breakdown } = scorePost(p, verdict);
      classified.push({ ...p, verdict, score, breakdown, kept: true });
    }

    // Parallel classifier calls in fixed-size batches for direct mode.
    for (let i = 0; i < directPosts.length; i += CLASSIFIER_CONCURRENCY) {
      const batch = directPosts.slice(i, i + CLASSIFIER_CONCURRENCY);
      const verdicts = await Promise.all(batch.map(p => classifyPost(p, prompts)));
      for (let j = 0; j < batch.length; j++) {
        const p = batch[j];
        const verdict = verdicts[j];
        const keeperClasses = new Set(['genuine_pain', 'solo_service_provider']);
        if (!verdict || !keeperClasses.has(verdict.class)) {
          classified.push({ ...p, verdict, kept: false });
          continue;
        }
        // Per-class sellerish cap. Solopreneurs announcing availability
        // inherently include a CTA/link/"DM me" — classifier honestly
        // labels this as sellerish=2-3. Reject them only above 3 (e.g.
        // packaged methodology with pricing tiers). Pain posts stay
        // strict: sellerish>1 means the vent is a sales setup.
        const sellerishCap = verdict.class === 'genuine_pain' ? 1 : 3;
        if ((verdict.sellerish ?? 0) > sellerishCap) {
          classified.push({ ...p, verdict, kept: false });
          continue;
        }
        const { score, breakdown } = scorePost(p, verdict);
        classified.push({ ...p, verdict, score, breakdown, kept: true });
      }
    }
    console.log(`[pain-finder] classifier: scanned=${toClassify.length} kept=${classified.filter(c => c.kept).length} concurrency=${CLASSIFIER_CONCURRENCY}`);
  }
  const keepers = classified.filter(c => c.kept);
  keepers.sort((a, b) => (b.score || 0) - (a.score || 0));

  // --- draft top N ---
  // In inline-query test mode, default to NO drafts (SKIP_DRAFTS implicit)
  // so iteration is fast. Override with SKIP_DRAFTS=0.
  const skipDrafts = SKIP_DRAFTS || (INLINE_QUERY && process.env.SKIP_DRAFTS !== '0');
  const toDraft = skipDrafts ? [] : keepers.slice(0, TOPN);
  for (const k of toDraft) {
    const draft = await draftReply(k, k.verdict, prompts, k.platform);
    k.draft = draft;
    if (draft?.draft) {
      // Auto-fix cosmetic violations (em-dash, trailing period) before
      // the voice gate. Applied to primary + alternates.
      const fixedPrimary = autoFixCosmetic(draft.draft);
      const fixedAlts = Array.isArray(draft.alternates) ? draft.alternates.map(autoFixCosmetic) : [];
      k.draft = { ...draft, draft: fixedPrimary, alternates: fixedAlts };

      const vc = voiceCheck(fixedPrimary, k.platform, 'reply');
      k.voiceOk = vc.ok;
      k.voiceReasons = vc.reasons;
      // if the primary failed, try each alternate
      if (!vc.ok) {
        for (const alt of fixedAlts) {
          const vcAlt = voiceCheck(alt, k.platform, 'reply');
          if (vcAlt.ok) {
            k.draft = { ...k.draft, draft: alt, alternates: [fixedPrimary, ...fixedAlts.filter(a => a !== alt)] };
            k.voiceOk = true;
            k.voiceReasons = [];
            break;
          }
        }
      }
    } else {
      k.voiceOk = false;
      k.voiceReasons = ['emptyDraft'];
    }
  }
  console.log(`[pain-finder] drafted=${toDraft.length} voice-passed=${toDraft.filter(x => x.voiceOk).length}`);

  // --- write outputs ---
  const out = runOutputPaths();
  const jsonlLines = [];
  for (const c of classified) jsonlLines.push(JSON.stringify(c));
  fs.writeFileSync(out.jsonl, jsonlLines.join('\n') + '\n');

  // In inline-query mode we want to review ALL classified posts, not
  // just keepers — the point is to judge whether the query finds the
  // right kind of person before we care about classifier filtering.
  const reviewSet = INLINE_QUERY
    ? [...keepers, ...classified.filter(c => !c.kept)]
    : toDraft;
  // per-query enrichment: map domain+q+platform to kept count (keepers already have domain + source_query)
  const keeperBuckets = new Map();
  for (const k of keepers) {
    const key = `${k.platform}::${k.source_query}`;
    keeperBuckets.set(key, (keeperBuckets.get(key) || 0) + 1);
  }
  const filteredBuckets = new Map();
  for (const f of filtered) {
    const key = `${f.platform}::${f.source_query}`;
    filteredBuckets.set(key, (filteredBuckets.get(key) || 0) + 1);
  }
  for (const q of perQuery) {
    const key = `${q.platform}::${q.q}`;
    q.filtered = filteredBuckets.get(key) || 0;
    q.kept = keeperBuckets.get(key) || 0;
  }

  writeMd(reviewSet, out.md, {
    ts: out.ts,
    platform: PLATFORM,
    recency: RECENCY,
    maxAgeHours: MAX_AGE_HOURS,
    queryCount: queries.length,
    harvestedCount: harvested.length,
    filteredCount: filtered.length,
    keptCount: keepers.length,
    promptsHash: prompts.hash,
    queriesFile: INLINE_QUERY ? `(inline) "${INLINE_QUERY}"` : QUERIES_FILE.replace(os.homedir(), '~'),
    inlineQuery: !!INLINE_QUERY,
    perQuery,
  });

  // Close the scraping tab so Chrome doesn't accumulate orphan tabs.
  // closeTarget can hang when Chrome is busy; race it against a 1.5s
  // timeout so the script always terminates quickly.
  try {
    await Promise.race([
      browser.closeTarget(page.targetId),
      new Promise(r => setTimeout(r, 1500)),
    ]);
  } catch { /* non-fatal */ }
  try { browser.close(); } catch { /* non-fatal */ }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[pain-finder] done in ${elapsed}s`);
  console.log(`  review: ${out.md}`);
  console.log(`  data:   ${out.jsonl}`);

  // Force exit — the CDP WebSocket + any timers otherwise keep the
  // event loop alive and block the outer query-iteration loop.
  process.exit(0);
}

main().catch(err => {
  console.error('[pain-finder] fatal:', err);
  process.exit(1);
});
