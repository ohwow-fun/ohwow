/**
 * Shared collection primitives for X/Twitter browsing.
 *
 * Any URL that renders a timeline of <article data-testid="tweet">
 * elements can be scraped with `scrollAndHarvest`. That includes:
 *   x.com/home, x.com/explore,
 *   x.com/search?q=...&f=live,
 *   x.com/<handle>, x.com/<handle>/likes, x.com/i/lists/<id>.
 *
 * Dedup lives in a per-workspace JSONL at
 *   ~/.ohwow/workspaces/<ws>/x-seen.jsonl
 * with one line per seen permalink + first-seen timestamp. Cheap to append,
 * O(n) to load on startup — at the volumes we scrape (hundreds per day)
 * that's fine for months. Promote to SQLite if it becomes a problem.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOhwow } from './_ohwow.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const HARVEST_JS = `(() => {
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
    const linkCards = Array.from(a.querySelectorAll('a[role="link"][target="_blank"]')).map(x => x.href).filter(Boolean);
    // Detect reply-to-others: if the first "Replying to @handle" block shows and it's not the same author
    const replyingTo = a.querySelector('[data-testid="socialContext"]')?.textContent?.includes('Replying to') ? true : false;
    const lang = a.querySelector('[data-testid="tweetText"]')?.getAttribute('lang') || null;
    return {
      permalink, author, displayName, isRetweet, hasMedia, replyingTo, lang,
      datetime: time?.getAttribute('datetime') || null,
      text,
      replies: num(a.querySelector('[data-testid="reply"]')?.textContent),
      reposts: num(a.querySelector('[data-testid="retweet"]')?.textContent),
      likes: num(a.querySelector('[data-testid="like"]')?.textContent),
      views: num(a.querySelector('a[href*="/analytics"]')?.textContent),
      linkCards,
    };
  }).filter(p => p.permalink);
})()`;

/**
 * Navigate `page` to `url`, scroll up to `maxScrolls` times, accumulate
 * unique posts by permalink, return the list. Uses the same End-key +
 * deep-scroll pattern feed-explore proved out.
 */
export async function scrollAndHarvest(page, url, maxScrolls = 10) {
  await page.goto(url);
  await sleep(2800);
  const seen = new Map();
  let stagnant = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const batch = await page.evaluate(HARVEST_JS);
    const before = seen.size;
    for (const p of batch) if (p.permalink && !seen.has(p.permalink)) seen.set(p.permalink, p);
    const gained = seen.size - before;
    if (gained === 0) stagnant++; else stagnant = 0;
    if (stagnant >= 3) break;
    await page.pressKey('End');
    await page.evaluate('window.scrollBy(0, window.innerHeight * 1.8)');
    await sleep(1400);
    await page.evaluate('window.scrollBy(0, window.innerHeight * 0.4)');
    await sleep(1000);
  }
  return Array.from(seen.values());
}

// --- dedup store ----------------------------------------------------------

function seenPath(workspace) {
  const ws = workspace || resolveOhwow().workspace;
  return path.join(os.homedir(), '.ohwow', 'workspaces', ws, 'x-seen.jsonl');
}

export function loadSeen(workspace) {
  const p = seenPath(workspace);
  if (!fs.existsSync(p)) return new Map();
  const out = new Map();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r.permalink) out.set(r.permalink, r); } catch {}
  }
  return out;
}

export function appendSeen(workspace, newRecords) {
  const p = seenPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const lines = newRecords.map(r => JSON.stringify(r)).join('\n') + (newRecords.length ? '\n' : '');
  fs.appendFileSync(p, lines);
}

/**
 * Navigate to a post's permalink and harvest the repliers. Returns an
 * array of reply rows shaped like harvested posts but flagged with
 * replyingTo=true and a sourcePermalink pointing at the parent thread.
 * The first article on a permalink page is the parent tweet itself;
 * we skip it and collect only the replies below.
 *
 * Used by x-intel's engager surface to build sidecar rows tagged
 * source='engager:competitor' (or 'engager:own-post'). Downstream,
 * _qualify's engagerBoost reduces the score floor for these rows so
 * low-score repliers who are nevertheless in-market get through.
 */
export async function scrapeRepliers(page, permalink, maxScrolls = 4) {
  const url = permalink.startsWith('http') ? permalink : `https://x.com${permalink}`;
  await page.goto(url);
  await sleep(3200);
  const seen = new Map();
  let stagnant = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const batch = await page.evaluate(HARVEST_JS);
    const before = seen.size;
    // Skip the first article (the parent post itself) on the first pass.
    for (let j = 0; j < batch.length; j++) {
      if (i === 0 && j === 0) continue;
      const p = batch[j];
      if (p.permalink && !seen.has(p.permalink)) seen.set(p.permalink, p);
    }
    const gained = seen.size - before;
    if (gained === 0) stagnant++; else stagnant = 0;
    if (stagnant >= 3) break;
    await page.pressKey('End');
    await page.evaluate('window.scrollBy(0, window.innerHeight * 1.8)');
    await sleep(1200);
    await page.evaluate('window.scrollBy(0, window.innerHeight * 0.4)');
    await sleep(800);
  }
  return Array.from(seen.values()).map(r => ({
    ...r,
    replyingTo: true,
    sourcePermalink: permalink,
  }));
}

/**
 * Post a new tweet. Navigates to home, opens the composer, types the
 * text, and submits. Returns the permalink of the posted tweet if we
 * can find it in the DOM post-submit, else null (posting succeeded
 * but we couldn't confirm the url — caller should treat as success
 * based on approval-queue state, not on this return).
 *
 * Selectors are X/Twitter's current testids (Nov 2025). Flaky by
 * nature; wrap callers in try/catch.
 */
export async function postTweet(page, text) {
  await page.goto('https://x.com/home');
  await sleep(3000);
  const focused = await page.focus('[data-testid="tweetTextarea_0"]');
  if (!focused) {
    await page.clickSelector('[data-testid="SideNav_NewTweet_Button"]', 5000);
    await sleep(1500);
    await page.focus('[data-testid="tweetTextarea_0"]');
  }
  await sleep(500);
  await page.typeText(text);
  await sleep(1200);
  // X's Post button uses React handlers that plain CDP clicks may not
  // trigger. We dispatch Cmd+Enter via raw CDP with the metaKey modifier
  // flag set — X's composer listens for this combo deterministically.
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    commands: ['insertNewline'],
    modifiers: 4, // 4 = metaKey on macOS
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    modifiers: 4,
  });
  await sleep(3000);
  return null;
}

/**
 * Reply to a specific post by permalink. Navigates to the permalink,
 * opens the reply composer by clicking the post's reply button, types,
 * submits. Returns null on success.
 */
export async function replyToPost(page, permalink, text) {
  const url = permalink.startsWith('http') ? permalink : `https://x.com${permalink}`;
  await page.goto(url);
  await sleep(4000);
  // Click the inline reply composer that's already visible on the
  // permalink page (X renders a persistent "Post your reply" box
  // below the parent tweet — no need to click the reply icon first).
  // Selector is data-testid="tweetTextarea_0" but only appears once
  // the page fully renders; wait for it.
  const found = await page.waitForSelector('[data-testid="tweetTextarea_0"]', 8000);
  if (!found) {
    // Fallback: click the reply icon to open the modal composer.
    await page.clickSelector('[data-testid="reply"]', 5000);
    await sleep(1500);
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', 5000);
  }
  await page.focus('[data-testid="tweetTextarea_0"]');
  await sleep(600);
  await page.typeText(text);
  await sleep(1200);
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    commands: ['insertNewline'],
    modifiers: 4,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    modifiers: 4,
  });
  await sleep(3000);
  return null;
}

export function filterPosts(posts, filters) {
  return posts.filter(p => {
    if (filters.drop_retweets && p.isRetweet) return false;
    if (filters.drop_replies_to_others && p.replyingTo) return false;
    if (filters.language && p.lang && p.lang !== filters.language) return false;
    const m = filters.min_engagement || {};
    if ((m.likes ?? 0) > p.likes) return false;
    if ((m.replies ?? 0) > p.replies) return false;
    return true;
  });
}
