/**
 * thread-read-respond.mjs — given a tweet permalink, read the focal
 * tweet + top replies and draft a smart reply (does NOT publish).
 *
 *   PERMALINK=/author/status/123 npx tsx scripts/x-experiments/thread-read-respond.mjs
 *   BRAND='ohwow'   # voice/positioning label passed to the LLM
 *   PITCH='local-first AI runtime that runs agents on your machine. MCP-first, multi-workspace, Ollama + Anthropic.'
 *   TONE='warm, direct, builder-to-builder, no marketing speak, no emojis'
 *   OUT=/tmp/x-reply-draft.json  # where the draft goes
 *   LIVE=1          # if set, actually opens the reply composer and types the draft (still requires a manual Post click unless LIVE_POST=1)
 *   LIVE_POST=1     # if set with LIVE, clicks Post automatically — DANGER
 */
import fs from 'node:fs';
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
import { complete, extractJson } from './_llm.mjs';
import { propose } from './_approvals.mjs';

const PERMALINK = process.env.PERMALINK;
if (!PERMALINK) { console.error('PERMALINK required (e.g. /author/status/123)'); process.exit(1); }
const BRAND = process.env.BRAND || 'ohwow';
const PITCH = process.env.PITCH || 'local-first AI runtime that runs agents on your machine. MCP-first, multi-workspace, Ollama + Anthropic.';
const TONE = process.env.TONE || 'warm, direct, builder-to-builder, no marketing speak, no emojis, lowercase ok, max 260 chars';
const OUT = process.env.OUT || '/tmp/x-reply-draft.json';
const LIVE = process.env.LIVE === '1';
const LIVE_POST = process.env.LIVE_POST === '1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const harvestJs = `(() => {
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const focal = articles.find(a => a.getAttribute('tabindex') === '-1') || articles[0];
  const focalIdx = articles.indexOf(focal);
  const pick = a => {
    const text = a.querySelector('[data-testid="tweetText"]')?.innerText || '';
    const handle = a.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href')?.slice(1) || null;
    const time = a.querySelector('time');
    const num = s => {
      if (!s) return 0;
      const m = String(s).replace(/[,\\s]/g,'').match(/([\\d.]+)([kKmM]?)/);
      if (!m) return 0;
      const n = parseFloat(m[1]);
      const mult = m[2]?.toLowerCase() === 'k' ? 1e3 : m[2]?.toLowerCase() === 'm' ? 1e6 : 1;
      return Math.round(n * mult);
    };
    return {
      handle,
      text,
      datetime: time?.getAttribute('datetime') || null,
      replies: num(a.querySelector('[data-testid="reply"]')?.textContent),
      reposts: num(a.querySelector('[data-testid="retweet"]')?.textContent),
      likes: num(a.querySelector('[data-testid="like"]')?.textContent),
    };
  };
  return {
    focal: focal ? pick(focal) : null,
    replies: articles.slice(focalIdx + 1).map(pick),
  };
})()`;

async function draftReply(focal, replies) {
  const sys = `You draft short Twitter/X replies for ${BRAND}.
${BRAND} = ${PITCH}
Voice: ${TONE}.
Rules:
- Only reply if we can add real value (a useful perspective, experience, or question that moves it forward). If not, shouldReply:false.
- Never pitch unless directly invited. Zero "check out our product" energy.
- Match the thread's register. Builder threads → concrete. Meme threads → skip.
- <= 260 chars. No hashtags. No "great thread".
Return STRICT JSON ONLY:
  {"shouldReply":true|false, "draft":"...", "rationale":"<=20 words why/why not"}`;
  const user = `Focal tweet by @${focal.handle} (${focal.likes}♥ ${focal.replies}💬):\n${focal.text}\n\nRecent replies (sample):\n${replies.slice(0, 10).map(r => `@${r.handle}: ${r.text.slice(0,200).replace(/\n/g,' ')}`).join('\n')}`;
  try {
    const txt = await complete({ system: sys, user, maxTokens: 600, purpose: 'reasoning' });
    return extractJson(txt);
  } catch (e) {
    return { draft: null, rationale: `llm failure: ${e.message}` };
  }
}

(async () => {
  const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
  const page = await findOrOpenXTab(browser);
  if (!page) { console.error('no x.com tab'); process.exit(1); }
  await page.installUnloadEscapes();
  await page.goto(`https://x.com${PERMALINK}`);
  await sleep(3500);

  const { focal, replies } = await page.evaluate(harvestJs);
  if (!focal) { console.error('could not find focal tweet'); process.exit(1); }
  console.log(`[thread] focal @${focal.handle} · ${focal.likes}♥ · ${replies.length} visible replies`);
  console.log(`  text: ${focal.text.slice(0, 140)}...`);

  const draft = await draftReply(focal, replies);
  console.log('\n[draft]', JSON.stringify(draft, null, 2));
  fs.writeFileSync(OUT, JSON.stringify({ permalink: PERMALINK, focal, draft, replies: replies.slice(0, 20) }, null, 2));
  console.log(`\nwritten to ${OUT}`);

  if (draft.shouldReply && draft.draft) {
    const entry = propose({
      kind: 'reply',
      summary: `@${focal.handle}: ${draft.draft.slice(0, 100)}`,
      payload: { permalink: PERMALINK, draft: draft.draft, focalHandle: focal.handle, rationale: draft.rationale },
    });
    console.log(`\n[approval] ${entry.status} · id=${entry.id.slice(0,8)} · trust: ${JSON.stringify(entry.trustStats)}`);
    if (entry.status === 'pending') {
      console.log('  queued for operator review. run: npx tsx scripts/x-experiments/approval-queue.mjs list');
    }
  }
  if (LIVE && draft.shouldReply && draft.draft) {
    console.log('\n[LIVE] opening reply composer…');
    const opened = await page.clickSelector('[data-testid="reply"]', 8000);
    if (!opened) { console.error('could not open reply composer'); process.exit(1); }
    await sleep(1500);
    const focused = await page.focus(`document.querySelector('[data-testid="tweetTextarea_0"]')`);
    if (!focused) { console.error('reply textarea not focusable'); process.exit(1); }
    await page.typeText(draft.draft);
    await sleep(600);
    console.log('  typed draft. Screenshot → /tmp/x-reply-typed.png');
    fs.writeFileSync('/tmp/x-reply-typed.png', Buffer.from(await page.screenshotPng(), 'base64'));
    if (LIVE_POST) {
      console.log('  LIVE_POST=1 → clicking tweetButton');
      const sent = await page.clickSelector('[data-testid="tweetButton"]', 8000);
      console.log('  sent:', sent);
      await sleep(2500);
      fs.writeFileSync('/tmp/x-reply-sent.png', Buffer.from(await page.screenshotPng(), 'base64'));
    } else {
      console.log('  LIVE_POST not set — left for human review');
    }
  }
  browser.close();
})().catch(e => { console.error(e); process.exit(1); });
