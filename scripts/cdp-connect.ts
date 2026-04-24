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
 * Module usage:
 *   import { cdpConnect, listDebugProfiles } from './cdp-connect.js'
 *   const { browser, page } = await cdpConnect({ profile: 'you@example.com', url: 'https://x.com' })
 *   // ... do stuff ...
 *   await browser.close()
 *
 * Profile resolution order:
 *   1. --profile / profile option (email, directory name, or local display name)
 *   2. OHWOW_CHROME_PROFILE env var
 *   3. 'Default'
 */

import { spawn, exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileEntry {
  directory: string;
  email: string | null;
  displayName: string | null;
}

export interface CdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
  browserContextId: string | null;
}

export interface ConnectOptions {
  /** Email, directory name (e.g. "Profile 2"), or local display name. Falls back to env/Default. */
  profile?: string;
  /** URL to navigate to after connecting. If omitted returns the browser only. */
  url?: string;
  /** If true, open a brand-new tab even if one for the URL already exists. Default: false (reuse). */
  freshTab?: boolean;
  /** CDP port. Default: 9222. */
  port?: number;
}

export interface ConnectResult {
  browser: RawBrowser;
  /** Attached page, or null if no URL was requested. */
  page: RawPage | null;
  /** Profile directory that Chrome was launched with (or is running with). */
  profileDir: string;
}

// ---------------------------------------------------------------------------
// Minimal raw CDP driver (self-contained, no imports from src/)
// ---------------------------------------------------------------------------

import WebSocket from 'ws';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function execCapture(cmd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout) => resolve({ stdout: stdout ?? '', code: err ? 1 : 0 }));
  });
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class RawBrowser {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private eventHandlers = new Map<string, Array<(p: unknown, sid?: string) => void>>();
  private _closed = false;

  private constructor(private wsUrl: string) {}

  static async connect(httpBase = `http://localhost:${CDP_PORT}`, timeoutMs = 8000): Promise<RawBrowser> {
    const v = await fetch(`${httpBase}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>);
    const b = new RawBrowser(v.webSocketDebuggerUrl);
    await b.openWs(timeoutMs);
    return b;
  }

  private openWs(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => { reject(new Error(`CDP connect timeout (${timeoutMs}ms)`)); this.ws?.close(); }, timeoutMs);
      this.ws.once('open', () => { clearTimeout(timer); resolve(); });
      this.ws.once('error', (e: Error) => { clearTimeout(timer); reject(e); });
      this.ws.on('message', (d: Buffer) => this.onMsg(d));
      this.ws.on('close', () => { this._closed = true; });
    });
  }

  private onMsg(data: Buffer): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      for (const h of this.eventHandlers.get(msg.method) ?? []) {
        try { h(msg.params, msg.sessionId as string | undefined); } catch { /* ignore */ }
      }
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this._closed) throw new Error('CDP connection closed');
    const id = ++this.nextId;
    const frame: Record<string, unknown> = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, []);
    this.eventHandlers.get(method)!.push(handler);
    return () => {
      const list = this.eventHandlers.get(method)!;
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  async getTargets(): Promise<CdpTarget[]> {
    const r = await this.send<{ targetInfos: Array<{ targetId: string; type: string; title: string; url: string; browserContextId?: string }> }>('Target.getTargets');
    return r.targetInfos.map((t) => ({
      targetId: t.targetId,
      type: t.type,
      title: t.title,
      url: t.url,
      browserContextId: t.browserContextId ?? null,
    }));
  }

  async attachToPage(targetId: string): Promise<RawPage> {
    const r = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new RawPage(this, r.sessionId, targetId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    this.on('Page.javascriptDialogOpening', (_p, sid) => {
      if (sid !== r.sessionId) return;
      this.send('Page.handleJavaScriptDialog', { accept: true }, r.sessionId).catch(() => {});
    });
    return page;
  }

  async createTarget(url = 'about:blank', browserContextId?: string): Promise<string> {
    const params: Record<string, unknown> = { url };
    if (browserContextId) params.browserContextId = browserContextId;
    const r = await this.send<{ targetId: string }>('Target.createTarget', params);
    return r.targetId;
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  close(): void {
    this._closed = true;
    this.ws?.close();
  }
}

export class RawPage {
  constructor(
    private browser: RawBrowser,
    public readonly sessionId: string,
    public readonly targetId: string,
  ) {}

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  async navigate(url: string, waitMs = 3000): Promise<void> {
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result.value as T;
  }

  async screenshot(): Promise<string> {
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return r.data;
  }

  async close(): Promise<void> {
    await this.browser.closeTarget(this.targetId);
  }
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
  if (!profiles.length) return id; // bootstrap hasn't run, pass through
  const match = profiles.find(
    (p) =>
      p.directory === id ||
      p.email === id ||
      p.displayName === id,
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
    if (cmd.includes(DEBUG_DIR)) {
      await execCapture(`kill -TERM ${pid}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Core connect function
// ---------------------------------------------------------------------------

export async function cdpConnect(opts: ConnectOptions = {}): Promise<ConnectResult> {
  const port = opts.port ?? CDP_PORT;
  const profileDir = resolveProfileDir(opts.profile);

  // Ensure Chrome is running on the CDP port
  if (!(await probeCdp(port))) {
    console.log(`[cdp-connect] no Chrome on :${port}, spawning with profile=${profileDir}`);
    await spawnChrome(profileDir, port);
  }

  const browser = await RawBrowser.connect(`http://localhost:${port}`);

  if (!opts.url) {
    return { browser, page: null, profileDir };
  }

  // Find or open a tab for the requested URL
  const targets = await browser.getTargets();
  const pages = targets.filter((t) => t.type === 'page');

  let targetId: string | null = null;

  if (!opts.freshTab) {
    // Reuse an existing tab whose URL matches the origin
    const origin = new URL(opts.url).origin;
    const existing = pages.find((t) => {
      try { return new URL(t.url).origin === origin; } catch { return false; }
    });
    if (existing) targetId = existing.targetId;
  }

  if (!targetId) {
    // Find any live page to get the browserContextId (so we open in the right profile)
    const anchor = pages[0];
    targetId = await browser.createTarget('about:blank', anchor?.browserContextId ?? undefined);
    await sleep(500);
  }

  const page = await browser.attachToPage(targetId);
  await page.navigate(opts.url, 2500);

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
    // Status check
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

  // Keep process alive so the browser stays connected (Ctrl+C to exit)
  console.log('[cdp-connect] press Ctrl+C to disconnect');
  process.on('SIGINT', () => { browser.close(); process.exit(0); });
  await new Promise(() => {});
}

// Run CLI only when executed directly
const isMain = process.argv[1]?.endsWith('cdp-connect.ts') || process.argv[1]?.endsWith('cdp-connect.js');
if (isMain) {
  cli().catch((err: unknown) => {
    console.error('[cdp-connect] error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
