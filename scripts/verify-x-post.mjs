/**
 * Manual end-to-end verifier for the X posting pipeline.
 *
 *   npx tsx scripts/verify-x-post.mjs                # dry run, "Keep building!"
 *   LIVE=1 npx tsx scripts/verify-x-post.mjs         # actually publishes
 *   TEXT='hello' LIVE=1 npx tsx scripts/verify-x-post.mjs
 *
 * Preconditions: debug Chrome running on :9222 with an x.com tab open
 * in the profile that owns the @ohwow_fun account. The script refuses
 * to post if the signed-in handle doesn't match EXPECTED_HANDLE below.
 *
 * Used to verify the raw-CDP path before changes propagate into the
 * orchestrator's deliverable-executor — Playwright's connectOverCDP
 * hangs 30s on ohwow's multi-profile debug Chrome; raw CDP works in
 * ~20ms. See src/execution/browser/raw-cdp.ts top-of-file comment.
 */
import { RawCdpBrowser, findOrOpenXTab } from '../src/execution/browser/raw-cdp.ts';
import fs from 'fs';

const LIVE = process.env.LIVE === '1';
const TEXT = process.env.TEXT || 'Keep building!';
const EXPECTED_HANDLE = process.env.EXPECTED_HANDLE || 'ohwow_fun';

console.log(`mode: ${LIVE ? 'LIVE (will publish)' : 'DRY RUN (will type, not publish)'}`);
console.log('text:', JSON.stringify(TEXT));
console.log('expected handle:', EXPECTED_HANDLE);

const t0 = Date.now();
const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
console.log(`connected raw CDP in ${Date.now()-t0}ms`);

const page = await findOrOpenXTab(browser);
if (!page) { console.log('FAIL: no x.com tab open'); process.exit(1); }
await page.installUnloadEscapes();

console.log('\n[1] identity check');
if (!/https:\/\/(x|twitter)\.com/.test(await page.url())) {
  await page.goto('https://x.com/home');
}
await new Promise(r => setTimeout(r, 2000));
const handle = await page.evaluate(`(() => {
  const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
  if (link) { const m = (link.getAttribute('href')||'').match(/^\\/([^/?#]+)/); return m ? m[1] : null; }
  return null;
})()`);
console.log('   signed-in handle:', handle);
if (handle !== EXPECTED_HANDLE) {
  console.log(`   FAIL: expected ${EXPECTED_HANDLE}, got ${handle}`);
  process.exit(1);
}

console.log('\n[2] navigate to compose');
await page.goto('https://x.com/compose/post');
await new Promise(r => setTimeout(r, 2500));

console.log('\n[3] focus + type');
const focused = await page.focus(`document.querySelector('[data-testid="tweetTextarea_0"]')`);
if (!focused) { console.log('FAIL: textarea not focusable'); process.exit(1); }
await page.typeText(TEXT);
await new Promise(r => setTimeout(r, 500));
const typed = await page.evaluate(`(() => { const el = document.querySelector('[data-testid="tweetTextarea_0"]'); return el ? el.textContent : null; })()`);
console.log('   typed (DOM):', JSON.stringify(typed));

console.log('\n[4] screenshot /tmp/x-compose.png');
fs.writeFileSync('/tmp/x-compose.png', Buffer.from(await page.screenshotPng(), 'base64'));

if (!LIVE) {
  console.log('\nDRY RUN COMPLETE. Re-run with LIVE=1 to publish.');
  browser.close();
  process.exit(0);
}

console.log('\n[5] click Post');
const clicked = await page.clickSelector('[data-testid="tweetButton"]', 10000);
if (!clicked) { console.log('FAIL: Post button unclickable'); process.exit(1); }
await new Promise(r => setTimeout(r, 3500));
fs.writeFileSync('/tmp/x-posted.png', Buffer.from(await page.screenshotPng(), 'base64'));
console.log('   url after publish:', await page.url());

console.log('\n[6] verify tweet landed on timeline');
await page.goto(`https://x.com/${EXPECTED_HANDLE}`);
await new Promise(r => setTimeout(r, 3000));
const recent = await page.evaluate(`(() => {
  const articles = document.querySelectorAll('article');
  return Array.from(articles).slice(0, 2).map(a => a.innerText.slice(0, 200).replace(/\\s+/g, ' '));
})()`);
for (const t of recent) console.log('   -', t);

console.log('\nLIVE COMPLETE.');
browser.close();
