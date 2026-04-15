/**
 * Smoke check for the self-bench browser primitive.
 *
 * Boots a headless Chromium, injects the daemon's local session
 * token into localStorage, navigates to the dashboard root + one
 * authed route, and prints the page title and visible H1 text so we
 * can eyeball that the auth injection works (no /login redirect).
 *
 * Also confirms the idle-evict closes the context without hanging
 * the script. Run:
 *
 *   npx tsx scripts/smoke-self-bench-browser.ts
 */
import { dashboardUrlForWorkspace, resolveActiveWorkspace } from '../src/config.js';
import {
  withPage,
  close,
  injectLocalSession,
  readLocalSessionToken,
} from '../src/self-bench/browser/self-bench-browser.js';

async function main(): Promise<void> {
  const workspace = resolveActiveWorkspace().name;
  const base = dashboardUrlForWorkspace(workspace);
  if (!base) {
    console.error(`[smoke] no port for workspace ${workspace}; is the daemon running?`);
    process.exit(1);
  }
  const token = readLocalSessionToken();
  console.log(`[smoke] workspace=${workspace}  base=${base}  token=${token ? token.slice(0, 8) + '…' : 'MISSING'}`);

  const report = await withPage(async (page) => {
    if (token) await injectLocalSession(page, token);

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    const netFailures: Array<{ url: string; status: number }> = [];
    page.on('response', (resp) => {
      if (resp.status() >= 400) netFailures.push({ url: resp.url(), status: resp.status() });
    });

    const t0 = Date.now();
    await page.goto(base, { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => null);
    const rootTitle = await page.title();
    const rootH1 = await page.locator('h1').first().textContent({ timeout: 1_000 }).catch(() => '(no h1)');
    const rootUrl = page.url();

    await page.goto(`${base}/agents`, { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => null);
    const agentsTitle = await page.title();
    const agentsUrl = page.url();

    const dt = Date.now() - t0;
    return { dt, rootTitle, rootH1, rootUrl, agentsTitle, agentsUrl, consoleErrors, netFailures };
  });

  console.log('[smoke] navigation report:');
  console.log(JSON.stringify(report, null, 2));

  console.log('[smoke] closing browser…');
  await close();
  console.log('[smoke] done');
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error('[smoke] fatal:', err);
    void close().finally(() => process.exit(1));
  },
);
