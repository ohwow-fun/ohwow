/**
 * Probe x.com/home in the already-open ohwow.fun profile tab.
 * Prints: signed-in handle, count of <article> elements, and the
 * shape of the first 3 articles (innerText head, key testids present).
 */
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';

const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
const page = await findOrOpenXTab(browser);
if (!page) { console.error('no x.com tab'); process.exit(1); }

await new Promise(r => setTimeout(r, 2500));
const url = await page.url();
const handle = await page.evaluate(`(() => {
  const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
  if (!link) return null;
  const m = (link.getAttribute('href')||'').match(/^\\/([^/?#]+)/);
  return m ? m[1] : null;
})()`);
console.log('url:', url);
console.log('handle:', handle);

const probe = await page.evaluate(`(() => {
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  return {
    count: articles.length,
    first3: articles.slice(0, 3).map(a => {
      const text = a.querySelector('[data-testid="tweetText"]');
      const userLink = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
      const time = a.querySelector('time');
      const permalink = time?.closest('a')?.getAttribute('href') || null;
      const replyBtn = a.querySelector('[data-testid="reply"]');
      const replyCount = replyBtn?.textContent || null;
      const likeCount = a.querySelector('[data-testid="like"]')?.textContent || null;
      const rtCount = a.querySelector('[data-testid="retweet"]')?.textContent || null;
      const viewCount = a.querySelector('a[href*="/analytics"]')?.textContent || null;
      return {
        author: userLink?.getAttribute('href') || null,
        time: time?.getAttribute('datetime') || null,
        permalink,
        textHead: (text?.textContent || '').slice(0, 140),
        replyCount, likeCount, rtCount, viewCount,
      };
    }),
  };
})()`);
console.log(JSON.stringify(probe, null, 2));
browser.close();
