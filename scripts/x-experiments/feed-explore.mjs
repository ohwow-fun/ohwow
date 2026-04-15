/**
 * feed-explore.mjs — explore x.com/home (or /explore or a list URL),
 * harvest tweets, and write "posts of interest" to a JSONL file.
 *
 *   FEED_URL=https://x.com/home      # default
 *   MAX_SCROLLS=12                   # default
 *   OUT=./x-feed.jsonl               # default (in repo root)
 *   PROFILE='Profile 1'              # default = ohwow.fun
 *   KEYWORDS='ai,agent,llm,local-first,ohwow'  # comma list, interest boost
 *   MIN_SCORE=0.4                    # only keep posts at/above this
 *   TOPIC='local-first AI agents, developer workflow tools'  # used by LLM scorer when ANTHROPIC_API_KEY is set
 *
 * Flow:
 *   1. Open (or reuse) x.com tab in the ohwow Chrome profile.
 *   2. Confirm signed-in handle, so we know what audience feed we're reading.
 *   3. Scroll N times, collecting articles between scrolls (the timeline
 *      virtualizes — rows unmount as they leave the viewport, so we have
 *      to snapshot each scroll window and dedupe by permalink).
 *   4. Score each unique post (heuristic + optional LLM), keep those
 *      above MIN_SCORE, sort by score desc, write JSONL.
 *
 * Deterministic, headless-friendly, workspace-agnostic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openProfileWindow } from '../../src/execution/browser/chrome-lifecycle.ts';
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
import { complete, extractJson } from './_llm.mjs';

const FEED_URL = process.env.FEED_URL || 'https://x.com/home';
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 12);
const OUT = path.resolve(process.env.OUT || './x-feed.jsonl');
const PROFILE = process.env.PROFILE || 'Profile 1';
const KEYWORDS = (process.env.KEYWORDS || 'ai,agent,llm,local-first,ollama,claude,mcp,browser,automation,opensource,developer,workflow')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MIN_SCORE = Number(process.env.MIN_SCORE || 0.4);
const TOPIC = process.env.TOPIC || 'local-first AI agents, developer workflow tools, MCP, browser automation';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureXTab(browser) {
  let page = await findOrOpenXTab(browser);
  if (page) return page;
  await openProfileWindow({ profileDir: PROFILE, url: FEED_URL, timeoutMs: 15000 });
  await sleep(2000);
  page = await findOrOpenXTab(browser);
  if (!page) throw new Error('could not open x.com tab');
  return page;
}

const harvestJs = `(() => {
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const num = (s) => {
    if (!s) return 0;
    const m = String(s).replace(/[,\\s]/g,'').match(/([\\d.]+)([kKmM]?)/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    const mult = m[2]?.toLowerCase() === 'k' ? 1e3 : m[2]?.toLowerCase() === 'm' ? 1e6 : 1;
    return Math.round(n * mult);
  };
  return articles.map(a => {
    const text = a.querySelector('[data-testid="tweetText"]')?.innerText || '';
    const userLink = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
    const time = a.querySelector('time');
    const permalink = time?.closest('a')?.getAttribute('href') || null;
    const author = userLink?.getAttribute('href')?.replace(/^\\//, '') || null;
    const displayName = a.querySelector('[data-testid="User-Name"] span')?.textContent || null;
    const isRetweet = !!a.querySelector('[data-testid="socialContext"]');
    const hasMedia = !!(a.querySelector('img[alt][draggable="true"]') || a.querySelector('video'));
    const hasQuote = !!a.querySelector('div[role="link"][tabindex="0"] article, div[aria-labelledby]:has([data-testid="User-Name"])');
    const linkCards = Array.from(a.querySelectorAll('a[role="link"][target="_blank"]')).map(x => x.href).filter(Boolean);
    return {
      permalink, author, displayName, isRetweet, hasMedia, hasQuote,
      datetime: time?.getAttribute('datetime') || null,
      text,
      replies: num(a.querySelector('[data-testid="reply"]')?.textContent),
      reposts: num(a.querySelector('[data-testid="retweet"]')?.textContent),
      likes: num(a.querySelector('[data-testid="like"]')?.textContent),
      views: num(a.querySelector('a[href*="/analytics"]')?.textContent),
      linkCards,
    };
  }).filter(p => p.permalink); // drop ads
})()`;

function heuristicScore(post) {
  const text = (post.text || '').toLowerCase();
  let score = 0;
  // keyword hits
  const hits = KEYWORDS.filter(k => text.includes(k));
  score += Math.min(0.5, hits.length * 0.12);
  // engagement (log-scaled)
  const engage = post.likes + post.reposts * 3 + post.replies * 2;
  score += Math.min(0.25, Math.log10(engage + 1) / 16); // ~0.25 at 10M
  // reach
  score += Math.min(0.15, Math.log10((post.views || 0) + 1) / 40);
  // signal: has a link card (often shares tool/article) OR ends with question
  if (post.linkCards?.length) score += 0.05;
  if (/\\?\\s*$/.test(post.text)) score += 0.05;
  // penalty: obvious spam/ads — super high likes but low replies
  if (post.likes > 1000 && post.replies < 3) score -= 0.1;
  return { score: Math.max(0, Math.min(1, score)), keywordHits: hits };
}

async function llmScoreBatch(posts) {
  const items = posts.map((p, i) => `#${i} @${p.author}: ${p.text.slice(0, 240).replace(/\n/g, ' ')}`).join('\n');
  const sys = `You rate tweets 0..1 for their relevance to: ${TOPIC}. Output ONLY strict JSON: {"scores":[{"i":0,"s":0.8,"why":"..."},...]}. 'why' is <= 12 words.`;
  try {
    const txt = await complete({ system: sys, user: items, maxTokens: 1500, purpose: 'simple_classification' });
    return extractJson(txt).scores;
  } catch (e) {
    console.error('[llm] score failed:', e.message);
    return null;
  }
}

(async () => {
  const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
  const page = await ensureXTab(browser);
  await page.installUnloadEscapes();

  if (!(await page.url()).startsWith(FEED_URL)) {
    await page.goto(FEED_URL);
    await sleep(2500);
  }

  const handle = await page.evaluate(`(() => {
    const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    return link ? link.getAttribute('href').slice(1) : null;
  })()`);
  console.log(`[feed-explore] signed-in as @${handle} on ${FEED_URL}`);

  const seen = new Map();
  let stagnant = 0;
  for (let i = 0; i < MAX_SCROLLS; i++) {
    const batch = await page.evaluate(harvestJs);
    const before = seen.size;
    for (const p of batch) if (p.permalink && !seen.has(p.permalink)) seen.set(p.permalink, p);
    const gained = seen.size - before;
    console.log(`  scroll ${i+1}/${MAX_SCROLLS} — +${gained} → ${seen.size} unique${stagnant ? ` (stagnant ${stagnant})` : ''}`);
    if (gained === 0) stagnant++; else stagnant = 0;
    if (stagnant >= 3) { console.log('  early-stop: 3 scrolls without new posts'); break; }
    // Press End, then jump to the scroll height. `End` reliably triggers
    // React virtualized list to fetch the next batch on x.com; scrollBy alone
    // gets throttled. Multiple half-page scrolls jump past the current
    // virtualized window so new items mount.
    await page.pressKey('End');
    await page.evaluate('window.scrollBy(0, window.innerHeight * 1.8)');
    await sleep(1600);
    // second nudge forces React scheduler flush
    await page.evaluate('window.scrollBy(0, window.innerHeight * 0.4)');
    await sleep(1200);
  }

  const posts = Array.from(seen.values());
  console.log(`[feed-explore] harvested ${posts.length} unique posts`);

  // heuristic score everyone
  for (const p of posts) {
    const h = heuristicScore(p);
    p.heuristicScore = h.score;
    p.keywordHits = h.keywordHits;
    p.score = h.score;
  }

  // optional LLM rescore for the top 30 heuristically
  const llmPool = [...posts].sort((a,b) => b.heuristicScore - a.heuristicScore).slice(0, 30);
  const llmScores = await llmScoreBatch(llmPool);
  if (llmScores) {
    for (const s of llmScores) {
      const p = llmPool[s.i];
      if (!p) continue;
      p.llmScore = s.s;
      p.llmWhy = s.why;
      p.score = p.heuristicScore * 0.3 + s.s * 0.7;
    }
    console.log('[feed-explore] LLM rescored top 30');
  } else {
    console.log('[feed-explore] LLM rescoring skipped (no ANTHROPIC_API_KEY or request failed)');
  }

  const kept = posts
    .filter(p => p.score >= MIN_SCORE)
    .sort((a,b) => b.score - a.score);

  fs.writeFileSync(OUT, kept.map(p => JSON.stringify(p)).join('\n') + '\n');
  console.log(`[feed-explore] kept ${kept.length}/${posts.length} posts at score>=${MIN_SCORE} → ${OUT}`);
  console.log('\nTop 5:');
  for (const p of kept.slice(0, 5)) {
    console.log(`  [${p.score.toFixed(2)}] @${p.author} · ${p.likes}♥ ${p.replies}💬 · ${p.text.slice(0,100).replace(/\\n/g,' ')}${p.llmWhy ? ` — ${p.llmWhy}` : ''}`);
  }

  browser.close();
})().catch(e => { console.error(e); process.exit(1); });
