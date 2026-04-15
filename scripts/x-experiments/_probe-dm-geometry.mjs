import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
const page = await findOrOpenXTab(browser);
const g = await page.evaluate(`(() => {
  const nodes = Array.from(document.querySelectorAll('[data-testid^="message-text-"]'));
  return nodes.slice(-8).map(n => {
    const r = n.getBoundingClientRect();
    return {
      left: Math.round(r.left),
      right: Math.round(r.right),
      width: Math.round(r.width),
      viewW: window.innerWidth,
      // bubble's centerpoint vs viewport center, normalized -1..1 (outbound ≈ +, inbound ≈ -)
      offset: ((r.left + r.right) / 2 - window.innerWidth / 2) / (window.innerWidth / 2),
      text: (n.innerText||'').slice(0, 50).replace(/\\n/g, ' '),
    };
  });
})()`);
console.log(JSON.stringify(g, null, 2));
browser.close();
