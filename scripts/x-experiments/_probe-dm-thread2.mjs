import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
const page = await findOrOpenXTab(browser);
await page.installUnloadEscapes();
const probe = await page.evaluate(`(() => {
  const all = Array.from(document.querySelectorAll('[data-testid]'));
  const freq = {};
  for (const el of all) {
    const t = el.getAttribute('data-testid') || '';
    if (t.match(/(message|dm|tweet)/i)) freq[t] = (freq[t] || 0) + 1;
  }
  return freq;
})()`);
console.log(JSON.stringify(probe, null, 2));
browser.close();
