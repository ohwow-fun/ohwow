/**
 * End-to-end repro: use scrapeRepliers on a fresh tab vs a findOrOpenXTab
 * tab, on the same thread. Prove the fix unambiguously.
 */
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
import { scrapeRepliers } from './_x-harvest.mjs';

const THREAD_A = process.env.THREAD_A || '/zapier/status/2044790480609649065';
const THREAD_B = process.env.THREAD_B || '/zapier/status/2044762806747083237';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);

// Path A: reused tab via findOrOpenXTab (current production behavior)
console.log('=== reused tab (findOrOpenXTab) ===');
const reused = await findOrOpenXTab(browser);
if (!reused) { console.error('no tab'); process.exit(1); }
await reused.installUnloadEscapes();
// Mimic x-intel by first scrolling the zapier profile
await reused.goto('https://x.com/zapier');
await sleep(3500);
for (let i = 0; i < 2; i++) {
  await reused.pressKey('End');
  await reused.evaluate('window.scrollBy(0, window.innerHeight * 1.8)');
  await sleep(1200);
}
// Then scrape the thread
for (const thread of [THREAD_A, THREAD_B]) {
  const rows = await scrapeRepliers(reused, thread, 6);
  const parent = thread.split('/')[1];
  const external = rows.filter(r => r.author && r.author !== parent);
  console.log(`  ${thread} → ${rows.length} raw · ${external.length} external [${external.slice(0, 5).map(r => '@' + r.author).join(',')}]`);
}

// Path B: fresh tab per scrape (proposed fix)
console.log('\n=== fresh tab per session ===');
const targets = await browser.getTargets();
const anchor = targets.find(t => t.type === 'page' && /https:\/\/(x|twitter)\.com/.test(t.url));
const freshTid = await browser.createTargetInContext(anchor.browserContextId, 'about:blank');
const fresh = await browser.attachToPage(freshTid);
await fresh.installUnloadEscapes();
// Same profile scroll
await fresh.goto('https://x.com/zapier');
await sleep(3500);
for (let i = 0; i < 2; i++) {
  await fresh.pressKey('End');
  await fresh.evaluate('window.scrollBy(0, window.innerHeight * 1.8)');
  await sleep(1200);
}
for (const thread of [THREAD_A, THREAD_B]) {
  const rows = await scrapeRepliers(fresh, thread, 6);
  const parent = thread.split('/')[1];
  const external = rows.filter(r => r.author && r.author !== parent);
  console.log(`  ${thread} → ${rows.length} raw · ${external.length} external [${external.slice(0, 5).map(r => '@' + r.author).join(',')}]`);
}
await fresh.closeAndCleanup();
