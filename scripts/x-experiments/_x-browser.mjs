/**
 * Deterministic Chrome + x.com session for x-experiments scripts.
 *
 * ensureXReady() guarantees: debug Chrome running on :9222 with an
 * x.com tab that has a logged-in session. If Chrome isn't running, it
 * spawns it with the configured profile. If no x.com tab exists, it
 * opens one. Returns a RawCdpPage ready for navigation.
 *
 * Used by: x-intel, x-compose, x-reply, dm-to-code, approval-queue.
 * Replaces the fragile pattern of `RawCdpBrowser.connect` + `findOrOpenXTab`
 * with null-check + bail that every script was duplicating and getting wrong.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CDP_PORT = 9222;
const DEBUG_DIR = path.join(os.homedir(), '.ohwow', 'chrome-debug');

async function probeCdp(port) {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

async function probeTargets(port) {
  try {
    const res = await fetch(`http://localhost:${port}/json`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return await res.json();
  } catch {}
  return [];
}

function resolveProfile() {
  return process.env.OHWOW_CHROME_PROFILE || 'Profile 1';
}

function chromeBinary() {
  const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(macPath)) return macPath;
  return 'google-chrome';
}

async function spawnChrome(profile) {
  if (!existsSync(DEBUG_DIR)) {
    throw new Error(`debug Chrome dir missing: ${DEBUG_DIR}. Run 'ohwow chrome bootstrap' first.`);
  }
  const child = spawn(chromeBinary(), [
    `--user-data-dir=${DEBUG_DIR}`,
    `--profile-directory=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  // Wait for CDP port
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await probeCdp(CDP_PORT)) return;
  }
  throw new Error('Chrome spawned but CDP not ready after 10s');
}

async function openXTab(browser) {
  // Use CDP Target.createTarget (works across Chrome versions; the
  // HTTP /json/new endpoint returns 405 on some builds).
  await browser.send('Target.createTarget', { url: 'https://x.com/home' });
  await sleep(5000);
}

/**
 * Returns a { browser, page } pair with a live x.com tab ready for use.
 * Spawns Chrome if needed, opens an x.com tab if missing.
 */
export async function ensureXReady() {
  const profile = resolveProfile();

  // Step 1: ensure Chrome is running on the CDP port.
  let ver = await probeCdp(CDP_PORT);
  if (!ver) {
    console.log(`[x-browser] no Chrome on :${CDP_PORT}, spawning with profile=${profile}`);
    await spawnChrome(profile);
    ver = await probeCdp(CDP_PORT);
    if (!ver) throw new Error('Chrome spawn failed');
  }

  // Step 2: connect via CDP.
  const browser = await RawCdpBrowser.connect(`http://localhost:${CDP_PORT}`, 5000);

  // Step 3: find or open x.com tab.
  let page = await findOrOpenXTab(browser);
  if (!page) {
    console.log('[x-browser] no x.com tab found, opening one');
    await openXTab(browser);
    page = await findOrOpenXTab(browser);
    if (!page) throw new Error('opened x.com tab but could not attach');
  }

  await page.installUnloadEscapes();
  return { browser, page };
}

/**
 * Open a FRESH x.com tab inside the same Chrome profile as whatever
 * existing x.com tab is around. Required for any x.com scraping:
 * x.com's SPA caches per-tab state, and a tab that was last touched
 * by another flow (abandoned compose/post window, stale status
 * thread, somebody else's profile page) may fail to hydrate
 * subsequent navigations. Symptoms observed:
 *
 *  - conversation-replies scrape returns only the focal tweet article
 *    (17th-pass diagnosis on /zapier/status/… threads: reused tab
 *    returned `1 raw · 0 external` across 10 scrolls; fresh tab
 *    returned `3-4 raw · 1-2 external` on scroll 0)
 *  - `page.goto('/home')` hangs indefinitely when the source tab is
 *    on a status permalink (18th-pass observation: 100+ seconds idle
 *    before manual kill)
 *
 * A fresh tab in the same Chrome profile context sidesteps both.
 * Callers should close it with `browser.closeTarget(page.targetId)`
 * when done (that keeps the shared WebSocket alive for any other
 * open pages; use `page.closeAndCleanup()` only when this is the
 * last page you have open).
 *
 * See `scripts/x-experiments/_probe-scrape.mjs` for the A/B repro.
 */
/**
 * Ensure Chrome is running on the CDP port and return a connected browser.
 * Spawns Chrome if needed; does NOT open or return a tab.
 * Use this when you want auto-spawn but need to pick your own tab strategy.
 */
export async function ensureBrowser() {
  const profile = resolveProfile();
  let ver = await probeCdp(CDP_PORT);
  if (!ver) {
    console.log(`[x-browser] no Chrome on :${CDP_PORT}, spawning with profile=${profile}`);
    await spawnChrome(profile);
    ver = await probeCdp(CDP_PORT);
    if (!ver) throw new Error('Chrome spawn failed');
  }
  return RawCdpBrowser.connect(`http://localhost:${CDP_PORT}`, 5000);
}

export async function openFreshXTab(browser) {
  const targets = await browser.getTargets();
  const anchor = targets.find(t => t.type === 'page' && /https:\/\/(x|twitter)\.com/.test(t.url));
  if (!anchor || !anchor.browserContextId) {
    throw new Error('[x-browser] openFreshXTab: no signed-in x.com tab to anchor the profile context');
  }
  const targetId = await browser.createTargetInContext(anchor.browserContextId, 'about:blank');
  const page = await browser.attachToPage(targetId);
  await page.installUnloadEscapes();
  return page;
}
