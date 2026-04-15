/**
 * Probe the DM inbox at x.com/messages to learn the list + thread DOM.
 * Pauses between opening inbox and clicking the first conversation.
 */
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
const page = await findOrOpenXTab(browser);
if (!page) { console.error('no x.com tab'); process.exit(1); }
await page.installUnloadEscapes();

await page.goto('https://x.com/messages');
await sleep(4000);

const inbox = await page.evaluate(`(() => {
  const items = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"]'));
  return {
    count: items.length,
    first5: items.slice(0, 5).map(el => ({
      testid: el.getAttribute('data-testid'),
      text: (el.innerText || '').slice(0, 240).replace(/\\s+/g, ' '),
      href: el.closest('a')?.getAttribute('href') || null,
    })),
  };
})()`);
console.log(JSON.stringify(inbox, null, 2));
browser.close();
