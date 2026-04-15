/**
 * Probe a DM conversation's DOM to find a reliable outbound/inbound signal.
 * Prints, for each message, up to 5 levels of ancestor data-testids + the
 * nearest anchor href.
 */
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
const page = await findOrOpenXTab(browser);
await page.goto('https://x.com/messages');
await sleep(3500);
await page.clickSelector('[data-testid^="dm-conversation-item-"]', 5000);
await sleep(3500);

const shape = await page.evaluate(`(() => {
  const nodes = Array.from(document.querySelectorAll('[data-testid^="message-text-"]'));
  return nodes.slice(0, 10).map(n => {
    const anc = [];
    let el = n.parentElement;
    for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
      const t = el.getAttribute('data-testid');
      const ar = el.getAttribute('aria-label');
      anc.push({ i, testid: t, aria: ar?.slice(0, 50), role: el.getAttribute('role'), tag: el.tagName });
    }
    const nearestA = n.closest('[role="row"], [role="group"], div[data-testid^="message-"]');
    const nearestAvatar = nearestA?.querySelector('a[href^="/"]')?.getAttribute('href') || null;
    return { text: (n.innerText||'').slice(0, 60), anc: anc.slice(0, 5), nearestAvatar };
  });
})()`);
console.log(JSON.stringify(shape, null, 2));
browser.close();
