/**
 * Open the first DM conversation and dump its message DOM shape.
 */
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
const page = await findOrOpenXTab(browser);
if (!page) { console.error('no tab'); process.exit(1); }
await page.installUnloadEscapes();
await page.goto('https://x.com/messages');
await sleep(3500);
const ok = await page.clickSelector('[data-testid^="dm-conversation-item-"]', 5000);
console.log('clicked conv?', ok);
await sleep(3500);
const probe = await page.evaluate(`(() => {
  const entries = Array.from(document.querySelectorAll('[data-testid="messageEntry"]'));
  return {
    url: location.href,
    entries: entries.length,
    sample: entries.slice(-10).map(el => {
      const t = el.querySelector('[data-testid="tweetText"]');
      return {
        text: (t?.innerText || el.innerText || '').slice(0, 240).replace(/\\s+/g,' '),
        fromMe: el.querySelector('[data-testid="dmMessage"]')?.getAttribute('data-testid') || null,
        raw: (el.innerText || '').slice(0, 240).replace(/\\s+/g,' '),
      };
    }),
    composerPresent: !!document.querySelector('[data-testid="dmComposerTextInput"]') || !!document.querySelector('textarea[data-testid="dm-composer-textarea"]'),
  };
})()`);
console.log(JSON.stringify(probe, null, 2));
browser.close();
