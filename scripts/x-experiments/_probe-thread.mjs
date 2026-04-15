/**
 * Probe a single tweet permalink page to learn the DOM shape:
 *   - which <article> is the root tweet
 *   - how replies are laid out (nested vs flat)
 *   - where "Show more replies" buttons live
 *
 * PERMALINK=/mkurman88/status/2044403192549478459 npx tsx scripts/x-experiments/_probe-thread.mjs
 */
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';

const PERMALINK = process.env.PERMALINK || '/mkurman88/status/2044403192549478459';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
const page = await findOrOpenXTab(browser);
if (!page) { console.error('no x.com tab'); process.exit(1); }
await page.installUnloadEscapes();
await page.goto(`https://x.com${PERMALINK}`);
await sleep(3500);

const probe = await page.evaluate(`(() => {
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const asText = a => (a.querySelector('[data-testid="tweetText"]')?.innerText || '').slice(0, 140).replace(/\\s+/g, ' ');
  const asHandle = a => a.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href')?.slice(1) || null;
  const permalinkOf = a => a.querySelector('time')?.closest('a')?.getAttribute('href') || null;
  // tweet-detail page marks the focal tweet with aria-labelledby containing "tweet-" and having no conversation parent
  const focal = articles.find(a => a.getAttribute('tabindex') === '-1') || articles[0];
  return {
    articles: articles.length,
    focalIndex: articles.indexOf(focal),
    items: articles.slice(0, 12).map((a, i) => ({
      i, focal: a === focal,
      handle: asHandle(a),
      permalink: permalinkOf(a),
      text: asText(a),
    })),
    showMoreRepliesButtons: document.querySelectorAll('[data-testid="cellInnerDiv"] div[role="button"][tabindex="0"]').length,
  };
})()`);
console.log(JSON.stringify(probe, null, 2));
browser.close();
