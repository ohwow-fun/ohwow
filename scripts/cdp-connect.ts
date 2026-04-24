/**
 * scripts/cdp-connect.ts — universal Chrome CDP connector
 *
 * CLI usage:
 *   tsx scripts/cdp-connect.ts                          # status check
 *   tsx scripts/cdp-connect.ts --list                   # list profiles
 *   tsx scripts/cdp-connect.ts --url https://x.com      # open URL (default profile)
 *   tsx scripts/cdp-connect.ts --profile you@example.com --url https://x.com
 *   tsx scripts/cdp-connect.ts --profile "Profile 2"    # by dir name
 *   tsx scripts/cdp-connect.ts --kill                   # kill debug Chrome
 *
 * Module usage (import into other scripts):
 *   import { cdpConnect, listDebugProfiles } from './cdp-connect.js'
 *   const { browser, page } = await cdpConnect({ profile: 'you@example.com', url: 'https://x.com' })
 *   // ... do stuff ...
 *   browser.close()
 *
 * Profile resolution order:
 *   1. --profile / profile option (email, directory name, or local display name)
 *   2. OHWOW_CHROME_PROFILE env var
 *   3. 'Default'
 *
 * The CDP driver (RawCdpBrowser / RawCdpPage) comes from
 * src/execution/browser/raw-cdp.ts — the canonical implementation shared
 * with all runtime code. No duplication.
 */

import { spawn, exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RawCdpBrowser, RawCdpPage } from '../src/execution/browser/raw-cdp.js';

// Re-export the canonical types so callers can use them without reaching
// into src/execution/browser directly.
export { RawCdpBrowser, RawCdpPage };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CDP_PORT = 9222;
const DEBUG_DIR = join(homedir(), '.ohwow', 'chrome-debug');
const CHROME_BIN =
  process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'google-chrome';
const LOCAL_STATE_PATH = join(DEBUG_DIR, 'Local State');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function execCapture(cmd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout) => resolve({ stdout: stdout ?? '', code: err ? 1 : 0 }));
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileEntry {
  directory: string;
  email: string | null;
  displayName: string | null;
}

export interface ConnectOptions {
  /** Email, directory name (e.g. "Profile 2"), or local display name. Falls back to env/Default. */
  profile?: string;
  /** URL to navigate to after connecting. If omitted returns the browser only. */
  url?: string;
  /** Open a brand-new tab even if one for the URL already exists. Default: false (reuse). */
  freshTab?: boolean;
  /** CDP port. Default: 9222. */
  port?: number;
}

export interface ConnectResult {
  browser: RawCdpBrowser;
  /** Attached page, or null if no URL was requested. */
  page: RawCdpPage | null;
  /** Profile directory that Chrome was launched with (or is running with). */
  profileDir: string;
}

// ---------------------------------------------------------------------------
// Profile enumeration
// ---------------------------------------------------------------------------

export function listDebugProfiles(): ProfileEntry[] {
  if (!existsSync(LOCAL_STATE_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(LOCAL_STATE_PATH, 'utf8')) as {
      profile?: { info_cache?: Record<string, { user_name?: string; name?: string }> };
    };
    const cache = raw.profile?.info_cache ?? {};
    return Object.entries(cache)
      .filter(([dir]) => existsSync(join(DEBUG_DIR, dir)))
      .map(([dir, entry]) => ({
        directory: dir,
        email: entry.user_name || null,
        displayName: entry.name || null,
      }));
  } catch {
    return [];
  }
}

function resolveProfileDir(identity?: string): string {
  const id = identity ?? process.env.OHWOW_CHROME_PROFILE ?? 'Default';
  const profiles = listDebugProfiles();
  if (!profiles.length) return id;
  const match = profiles.find(
    (p) => p.directory === id || p.email === id || p.displayName === id,
  );
  return match?.directory ?? id;
}

// ---------------------------------------------------------------------------
// Chrome lifecycle
// ---------------------------------------------------------------------------

async function probeCdp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function spawnChrome(profileDir: string, port: number): Promise<void> {
  if (!existsSync(DEBUG_DIR)) {
    throw new Error(`Debug Chrome dir missing at ${DEBUG_DIR}. Run: ohwow chrome bootstrap`);
  }
  const child = spawn(
    CHROME_BIN,
    [
      `--user-data-dir=${DEBUG_DIR}`,
      `--profile-directory=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await probeCdp(port)) return;
  }
  throw new Error(`Chrome spawned but CDP port ${port} not ready after 10s`);
}

async function killDebugChrome(): Promise<void> {
  if (process.platform === 'win32') return;
  const { stdout } = await execCapture('pgrep -f "Google Chrome.app/Contents/MacOS/Google Chrome"');
  const pids = stdout.trim().split('\n').map(Number).filter(Boolean);
  for (const pid of pids) {
    const { stdout: cmd } = await execCapture(`ps -o command= -p ${pid}`);
    if (cmd.includes(DEBUG_DIR)) await execCapture(`kill -TERM ${pid}`);
  }
}

// ---------------------------------------------------------------------------
// Core connect function
// ---------------------------------------------------------------------------

export async function cdpConnect(opts: ConnectOptions = {}): Promise<ConnectResult> {
  const port = opts.port ?? CDP_PORT;
  const profileDir = resolveProfileDir(opts.profile);

  if (!(await probeCdp(port))) {
    console.log(`[cdp-connect] no Chrome on :${port}, spawning with profile=${profileDir}`);
    await spawnChrome(profileDir, port);
  }

  const browser = await RawCdpBrowser.connect(`http://localhost:${port}`);

  if (!opts.url) return { browser, page: null, profileDir };

  const targets = await browser.getTargets();
  const pages = targets.filter((t) => t.type === 'page');

  let targetId: string | null = null;

  if (!opts.freshTab) {
    const origin = new URL(opts.url).origin;
    const existing = pages.find((t) => {
      try { return new URL(t.url).origin === origin; } catch { return false; }
    });
    if (existing) targetId = existing.targetId;
  }

  if (!targetId) {
    const anchor = pages[0];
    targetId = await browser.createTargetInContext(
      anchor?.browserContextId ?? '',
      'about:blank',
    ).catch(() => browser.createTargetDefault('about:blank'));
    await sleep(500);
  }

  const page = await browser.attachToPage(targetId);
  await page.goto(opts.url);

  return { browser, page, profileDir };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const opt = (name: string) => {
    const i = args.findIndex((a) => a === `--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (flag('list')) {
    const profiles = listDebugProfiles();
    if (!profiles.length) {
      console.log('No profiles found. Run: ohwow chrome bootstrap');
      return;
    }
    console.log('Debug Chrome profiles:');
    for (const p of profiles) {
      console.log(`  ${p.directory.padEnd(14)} ${(p.email ?? '(no Google account)').padEnd(30)} ${p.displayName ?? ''}`);
    }
    return;
  }

  if (flag('kill')) {
    console.log('[cdp-connect] killing debug Chrome...');
    await killDebugChrome();
    await sleep(500);
    console.log('[cdp-connect] done');
    return;
  }

  const profile = opt('profile');
  const url = opt('url');
  const fresh = flag('fresh');

  if (!url) {
    const alive = await probeCdp(CDP_PORT);
    console.log(`Debug Chrome on :${CDP_PORT}: ${alive ? 'running' : 'not running'}`);
    if (alive) {
      const profiles = listDebugProfiles();
      if (profiles.length) {
        console.log('Available profiles:');
        for (const p of profiles) {
          console.log(`  ${p.directory.padEnd(14)} ${p.email ?? '(no account)'}`);
        }
      }
      const { stdout: pid } = await execCapture('pgrep -f "Google Chrome.app/Contents/MacOS/Google Chrome"');
      console.log(`PID(s): ${pid.trim() || 'unknown'}`);
    }
    console.log('\nUsage:');
    console.log('  tsx scripts/cdp-connect.ts --list');
    console.log('  tsx scripts/cdp-connect.ts --url https://x.com --profile you@example.com');
    console.log('  tsx scripts/cdp-connect.ts --kill');
    return;
  }

  console.log(`[cdp-connect] connecting${profile ? ` as ${profile}` : ''}...`);
  const { browser, page, profileDir } = await cdpConnect({ profile, url, freshTab: fresh });
  console.log(`[cdp-connect] ready  profile=${profileDir}  url=${url}`);

  if (page) {
    const title = await page.evaluate<string>('document.title');
    console.log(`[cdp-connect] page title: "${title}"`);
  }

  console.log('[cdp-connect] press Ctrl+C to disconnect');
  process.on('SIGINT', () => { browser.close(); process.exit(0); });
  await new Promise(() => {});
}

const isMain = process.argv[1]?.endsWith('cdp-connect.ts') || process.argv[1]?.endsWith('cdp-connect.js');
if (isMain) {
  cli().catch((err: unknown) => {
    console.error('[cdp-connect] error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
