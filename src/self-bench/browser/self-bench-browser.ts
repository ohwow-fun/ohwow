/**
 * Self-bench browser primitive — a dedicated headless Playwright
 * Chromium isolated from LocalBrowserService (which is the agent-
 * facing, Stagehand-backed browser used by real tasks).
 *
 * Why not reuse LocalBrowserService:
 *   - It's a singleton across agents; a self-bench tick every 5min
 *     would either wait behind a running agent task or race it.
 *   - It pulls in Stagehand's AI act/extract primitives; self-bench
 *     needs DOM/console/network only, no model calls.
 *   - It uses the operator's real Chrome profile; we want an
 *     isolated ephemeral profile so logging in, clicking around,
 *     and evicting state never leaks into the operator's browser.
 *
 * Model
 * -----
 * Persistent context under
 * ~/.ohwow/workspaces/<name>/self-bench-browser/ so cookies +
 * localStorage survive across ticks (faster than a cold launch
 * every tick). Serialized via `withPage` — one caller at a time —
 * so concurrent probe ticks don't collide on the same page. The
 * browser idle-evicts itself after IDLE_EVICT_MS of no use.
 *
 * Auth
 * ----
 * injectLocalSession(page, token) writes the Bearer token into
 * localStorage (key 'ohwow-session-token', as the web UI client
 * reads it) via addInitScript BEFORE the first navigation, so
 * every request the page makes is authenticated from the first
 * load. Callers that only need the public HTML (no API data) can
 * skip the inject.
 *
 * Kill switch
 * -----------
 * None — this primitive only reads. It never writes commits, never
 * mutates the DB, never calls an LLM. It's safe to call from any
 * experiment regardless of the safety-floor switches. The decision
 * of whether to ACT on what it observes stays with the caller.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { logger } from '../../lib/logger.js';
import { resolveActiveWorkspace, workspaceLayoutFor } from '../../config.js';

/** Close the browser after this long idle. Balances boot cost vs memory. */
const IDLE_EVICT_MS = 90 * 1000;
/** Hard ceiling on per-page navigations in one tick — guard runaway loops. */
const MAX_NAV_PER_CALL = 50;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
/** localStorage key the web UI's api/client.ts reads the Bearer token from. */
const SESSION_TOKEN_KEY = 'ohwow-session-token';

interface LiveContext {
  ctx: BrowserContext;
  page: Page;
  idleTimer: NodeJS.Timeout | null;
}

let live: LiveContext | null = null;
let mutex: Promise<void> = Promise.resolve();
let navigationsSinceLaunch = 0;

/** Path Chromium uses to persist cookies + localStorage across ticks. */
export function selfBenchUserDataDir(workspaceName?: string): string {
  const layout = workspaceName
    ? workspaceLayoutFor(workspaceName)
    : resolveActiveWorkspace();
  return path.join(layout.dataDir, 'self-bench-browser');
}

/**
 * Read the local session token for a workspace. Returns null if the
 * daemon has never run (no token file yet) — callers that need auth
 * should treat that as "can't probe yet" and no-op.
 */
export function readLocalSessionToken(workspaceName?: string): string | null {
  const layout = workspaceName
    ? workspaceLayoutFor(workspaceName)
    : resolveActiveWorkspace();
  const p = path.join(layout.dataDir, 'daemon.token');
  try {
    const raw = fs.readFileSync(p, 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Inject the Bearer token into localStorage BEFORE the first paint,
 * so the web UI's api/client.ts picks it up on its initial data
 * fetch rather than redirecting to /login.
 *
 * Idempotent: running addInitScript twice just replaces the earlier
 * script on subsequent navigations — we don't chain them.
 */
export async function injectLocalSession(
  page: Page,
  token: string,
): Promise<void> {
  if (!token || typeof token !== 'string') {
    throw new Error('injectLocalSession: token must be a non-empty string');
  }
  // The init script runs in the page context where `window` and
  // `localStorage` exist. Declared here with `any` because this file
  // is compiled under node tsconfig — the script body only executes
  // inside Chromium and never touches anything from this module.
  await page.addInitScript(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ key, value }: { key: string; value: string }) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).localStorage?.setItem(key, value);
      } catch {
        // storage can be blocked on file:// or data: URLs — non-fatal
      }
    },
    { key: SESSION_TOKEN_KEY, value: token },
  );
}

async function ensureLive(): Promise<LiveContext> {
  if (live) return live;
  const userDataDir = selfBenchUserDataDir();
  fs.mkdirSync(userDataDir, { recursive: true });
  logger.debug({ userDataDir }, '[self-bench-browser] launching persistent context');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: DEFAULT_VIEWPORT,
  });
  const page = (await ctx.pages())[0] ?? (await ctx.newPage());
  live = { ctx, page, idleTimer: null };
  return live;
}

function scheduleEvict(): void {
  if (!live) return;
  if (live.idleTimer) clearTimeout(live.idleTimer);
  live.idleTimer = setTimeout(() => {
    void close().catch((err) => {
      logger.debug({ err }, '[self-bench-browser] idle close failed');
    });
  }, IDLE_EVICT_MS);
  // Let the process exit even if the timer is pending.
  live.idleTimer.unref?.();
}

/**
 * Run one probe against the page. Serialized via an internal mutex
 * so overlapping experiment ticks don't clobber each other on the
 * same Chromium page. Callers get exclusive access for the duration
 * of their fn.
 */
export async function withPage<T>(
  fn: (page: Page, ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  const prev = mutex;
  let release!: () => void;
  mutex = new Promise<void>((res) => { release = res; });
  await prev;
  try {
    const l = await ensureLive();
    navigationsSinceLaunch++;
    if (navigationsSinceLaunch > MAX_NAV_PER_CALL * 1000) {
      // Periodic cold-restart so long-lived contexts don't accumulate
      // memory (Playwright holds on to response bodies, etc.).
      await close();
      navigationsSinceLaunch = 0;
    }
    const result = await fn(l.page, l.ctx);
    scheduleEvict();
    return result;
  } finally {
    release();
  }
}

/** Force-close. Used by tests and by the idle-evict timer. */
export async function close(): Promise<void> {
  if (!live) return;
  const { ctx, idleTimer } = live;
  if (idleTimer) clearTimeout(idleTimer);
  live = null;
  navigationsSinceLaunch = 0;
  try {
    await ctx.close();
  } catch (err) {
    logger.debug({ err }, '[self-bench-browser] close error (ignored)');
  }
}

export const SELF_BENCH_BROWSER_INTERNALS = {
  SESSION_TOKEN_KEY,
  IDLE_EVICT_MS,
  DEFAULT_VIEWPORT,
} as const;
