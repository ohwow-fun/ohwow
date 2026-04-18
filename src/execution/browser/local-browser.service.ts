/**
 * Local Browser Service
 * Wraps Stagehand v3 for AI-powered local Chromium browser automation.
 * Provides the same capabilities as the cloud browser package (act, extract,
 * agent_task) but runs on the user's machine with their residential IP.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserSnapshot,
} from './browser-types.js';
import { logger } from '../../lib/logger.js';
import {
  ChromeLifecycleError,
  DEBUG_DATA_DIR,
  assertNoConsentPending,
  ensureDebugChrome,
  findProfileByIdentity,
  listProfiles,
} from './chrome-lifecycle.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StagehandInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StagehandPage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StagehandContext = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let StagehandClass: any = null;

async function loadStagehand(): Promise<{ Stagehand: new (...args: unknown[]) => StagehandInstance }> {
  if (!StagehandClass) {
    try {
      const mod = await import('@browserbasehq/stagehand');
      StagehandClass = mod.Stagehand;
    } catch {
      throw new Error(
        'Browser automation requires @browserbasehq/stagehand. Install it with: npm install @browserbasehq/stagehand',
      );
    }
  }
  return { Stagehand: StagehandClass };
}

export interface LocalBrowserServiceOptions {
  headless?: boolean;
  /** Stagehand model in 'provider/model' format. Default: auto-detect from available keys. */
  modelName?: string;
  /** API key for the model provider. */
  modelApiKey?: string;
  /**
   * Optional custom base URL for the model provider. Used to route the
   * OpenAI-compatible provider at OpenRouter when that is the only key
   * the user has configured. When set, passed through to
   * `modelClientOptions.baseURL` on Stagehand init.
   */
  modelBaseURL?: string;
  /** CDP WebSocket URL to connect to an existing browser (e.g. real Chrome). When set, Stagehand connects via CDP instead of launching Chromium. */
  cdpUrl?: string;
  /**
   * Skip the default debug-Chrome attach attempt and spawn bundled
   * Chromium directly. Use this when the caller explicitly needs an
   * isolated browser with no real profile state (tests, one-shot PDF
   * rendering, screenshot-only flows, or a fallback site that has
   * already probed CDP itself and failed). Ignored when `cdpUrl` is
   * passed — an explicit CDP URL always wins.
   */
  forceBundled?: boolean;
}

/**
 * Synchronously read a minimal slice of `~/.ohwow/config.json` so the
 * Stagehand default-model resolver can see the user's runtime config
 * without forcing every caller to plumb credentials in by hand. The
 * full `loadConfig()` in `../../config.js` is async and layers
 * workspace overrides — for the browser default-resolver we just need
 * the top-level `anthropicApiKey` / `openRouterApiKey` / `openaiApiKey`
 * fields. Returns `{}` on any error (missing file, parse failure).
 *
 * This mirrors how `config.ts` resolves file config: same path, same
 * field names. It runs exactly once per LocalBrowserService instance.
 */
interface StagehandFileConfigSlice {
  anthropicApiKey?: string;
  openRouterApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
}
function readRuntimeConfigSlice(): StagehandFileConfigSlice {
  try {
    const configPath = join(homedir(), '.ohwow', 'config.json');
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pick = (k: string): string | undefined => {
      const v = parsed[k];
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    };
    return {
      anthropicApiKey: pick('anthropicApiKey'),
      openRouterApiKey: pick('openRouterApiKey'),
      openaiApiKey: pick('openaiApiKey'),
      googleApiKey: pick('googleApiKey'),
    };
  } catch {
    return {};
  }
}

/**
 * Resolve a Stagehand-compatible model + apiKey + baseURL from the
 * credentials the user actually has. Stagehand v3's Vercel aiSDK
 * integration only accepts specific provider names (openai, anthropic,
 * google, etc.) — it does NOT accept 'openrouter'. When the only key
 * we have is an OpenRouter key, we route through the OpenAI provider
 * with `baseURL: https://openrouter.ai/api/v1`, which is OpenAI
 * wire-compatible and unblocks AI-driven browser tools.
 *
 * Exported for unit testing and for the runtime orchestrator which
 * can reuse the same resolution when constructing LocalBrowserService.
 */
export function resolveStagehandCredentials(
  env: NodeJS.ProcessEnv,
  fileConfig: StagehandFileConfigSlice,
): { model: string; apiKey: string; baseURL?: string } {
  const anthropicKey = env.ANTHROPIC_API_KEY || fileConfig.anthropicApiKey;
  if (anthropicKey) {
    return { model: 'anthropic/claude-sonnet-4-5', apiKey: anthropicKey };
  }
  const openaiKey = env.OPENAI_API_KEY || fileConfig.openaiApiKey;
  if (openaiKey) {
    return { model: 'openai/gpt-4o-mini', apiKey: openaiKey };
  }
  const googleKey = env.GOOGLE_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY || fileConfig.googleApiKey;
  if (googleKey) {
    return { model: 'google/gemini-2.0-flash-exp', apiKey: googleKey };
  }
  const openRouterKey = env.OPENROUTER_API_KEY || fileConfig.openRouterApiKey;
  if (openRouterKey) {
    // Route the OpenAI provider at OpenRouter's OpenAI-compatible API.
    // Model id format is OpenRouter-style ("vendor/model").
    return {
      model: 'openai/gpt-4o-mini',
      apiKey: openRouterKey,
      baseURL: 'https://openrouter.ai/api/v1',
    };
  }
  return { model: 'openai/gpt-4o-mini', apiKey: '' };
}

// ============================================================================
// LOCAL BROWSER SERVICE
// ============================================================================

export class LocalBrowserService {
  private stagehand: StagehandInstance | null = null;
  private page: StagehandPage = null;
  private ctx: StagehandContext = null;
  private headless: boolean;
  private modelName: string;
  private modelApiKey: string;
  private modelBaseURL: string | undefined;
  private cdpUrl: string | undefined;
  private forceBundled: boolean;
  private initPromise: Promise<StagehandPage> | null = null;

  constructor(opts?: LocalBrowserServiceOptions) {
    this.headless = opts?.headless !== false; // default headless
    // Resolution order is: explicit opts → process.env → runtime config
    // file at ~/.ohwow/config.json. Reading the config file slice is
    // synchronous and cheap (one JSON parse at construction time), and
    // lets the daemon pick up credentials the user has in their config
    // without also exporting them to process.env. Before this change,
    // LocalBrowserService only looked at process.env and initialized
    // Stagehand with apiKey: '' on every daemon boot because the user
    // had OpenRouter configured in config.json but nothing in env.
    const resolved = resolveStagehandCredentials(process.env, readRuntimeConfigSlice());
    this.modelName = opts?.modelName || resolved.model;
    this.modelApiKey = opts?.modelApiKey || resolved.apiKey || '';
    this.modelBaseURL = opts?.modelBaseURL || resolved.baseURL;
    this.cdpUrl = opts?.cdpUrl;
    this.forceBundled = opts?.forceBundled === true;
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  async ensureBrowser(): Promise<StagehandPage> {
    if (this.page) return this.page;
    // Prevent concurrent initialization — second caller waits for the first
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initBrowser();
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async _initBrowser(): Promise<StagehandPage> {

    try {
      // Reuse debug Chrome by default; isolate only when caller explicitly asks.
      // Automation tasks that came in without a cdpUrl used to spawn a fresh
      // bundled Chromium every time — throwing away the user's real logged-in
      // sessions and (when running in parallel) racing on Playwright's user-
      // data-dir lock. Attaching to the existing debug Chrome on :9222 gives
      // every automation the user's real cookies and lets the per-profile
      // routing work downstream. Only skip this when `forceBundled` is true.
      if (!this.cdpUrl && !this.forceBundled) {
        try {
          const handle = await ensureDebugChrome({ port: 9222 });
          this.cdpUrl = handle.cdpHttpUrl;
          logger.debug(
            { cdpUrl: this.cdpUrl, pid: handle.pid },
            '[browser] attaching to debug Chrome via CDP (default)',
          );
        } catch (err) {
          const reason = err instanceof ChromeLifecycleError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
          logger.warn(
            { reason },
            '[browser] debug Chrome attach failed, falling back to bundled Chromium',
          );
          // Leave this.cdpUrl unset — Stagehand will launch bundled Chromium.
        }
      }

      const { Stagehand } = await loadStagehand();
      const launchOpts: Record<string, unknown> = this.cdpUrl
        ? { cdpUrl: this.cdpUrl }
        : { headless: this.headless };
      logger.debug(`[browser] Stagehand.init. ${this.cdpUrl ? `cdp: ${this.cdpUrl}` : `headless: ${this.headless}`}, model: ${this.modelName}, apiKey: ${this.modelApiKey ? 'set' : 'MISSING. extract/act/agent will fail'}${this.modelBaseURL ? `, baseURL: ${this.modelBaseURL}` : ''}`);
      // Stagehand v3 expects the API key via modelClientOptions (not
      // process.env) so we can honour whatever credential resolution the
      // rest of the daemon does. modelBaseURL is set when we're routing
      // an OpenRouter key through the openai provider (Stagehand's aiSDK
      // doesn't recognize 'openrouter' as a first-class provider).
      const modelClientOptions: Record<string, unknown> = {};
      if (this.modelApiKey) modelClientOptions.apiKey = this.modelApiKey;
      if (this.modelBaseURL) modelClientOptions.baseURL = this.modelBaseURL;
      this.stagehand = new Stagehand({
        env: 'LOCAL',
        localBrowserLaunchOptions: launchOpts,
        model: this.modelName,
        modelClientOptions,
        verbose: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await this.stagehand.init();
      this.ctx = this.stagehand.context;
      this.page = this.ctx.activePage();
      // CDP connections may not have an active page — create one or use the first available
      if (!this.page && this.cdpUrl) {
        const pages = this.ctx.pages?.() || [];
        this.page = pages[0] || await this.ctx.newPage();
        logger.debug(`[browser] CDP: no active page, using ${pages.length > 0 ? 'first existing' : 'new'} page`);
      }
      logger.info(`[browser] Stagehand v3 initialized${this.cdpUrl ? ' (CDP → Chrome)' : ''}`);
      return this.page;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Executable doesn\'t exist') || msg.includes('browserType.launch')) {
        throw new Error('Chromium is not installed. Run: npx playwright install chromium');
      }
      throw err;
    }
  }

  isActive(): boolean {
    return this.stagehand !== null && this.page !== null;
  }

  /**
   * Which backend this service is driving. 'chrome-cdp' = CDP-attached to
   * the user's real Chrome (has their cookies / logins). 'chromium' =
   * isolated bundled Chromium (anonymous, no real profile). The cloud
   * orchestrator uses this to tag tool results accurately and stop
   * hallucinating "opened in your real Chrome" when it's actually in a
   * fresh Chromium with no session.
   */
  getBackend(): 'chrome-cdp' | 'chromium' | 'uninitialized' {
    if (!this.stagehand) return 'uninitialized';
    return this.cdpUrl ? 'chrome-cdp' : 'chromium';
  }

  getPage(): StagehandPage | null {
    return this.page;
  }

  /**
   * Close the Stagehand wrapper.
   *
   * Two distinct cases matter here:
   *
   *   1. We spawned our own bundled Chromium (no cdpUrl). Calling
   *      stagehand.close() terminates that process cleanly — correct.
   *
   *   2. We attached to a pre-existing Chrome via CDP (cdpUrl set).
   *      Calling stagehand.close() would also terminate the underlying
   *      Chrome, which is the user's REAL logged-in browser with all
   *      their sessions, tabs, and cookies. That is never what we want
   *      on daemon shutdown or orchestrator teardown. Detach by
   *      nulling our references and let the CDP WebSocket close when
   *      the stagehand object is garbage-collected.
   *
   * This was the root cause of a launch-eve incident: every daemon
   * restart was killing the user's Chrome (and their Product Hunt
   * login). Now the restart is safe.
   */
  async close(): Promise<void> {
    try {
      if (this.stagehand) {
        if (this.cdpUrl) {
          logger.debug('[browser] close() detected CDP-attached mode — leaving Chrome alive for the user');
        } else {
          await this.stagehand.close().catch(() => {});
        }
      }
    } finally {
      this.stagehand = null;
      this.page = null;
      this.ctx = null;
    }
  }

  // ==========================================================================
  // CHROME CDP CONNECTION (delegates to chrome-lifecycle.ts)
  // ==========================================================================
  //
  // Everything below used to live here as a pile of private static
  // helpers — cloning the user's real Chrome dir into
  // `~/.ohwow/chrome-debug/`, quitting the user's real Chrome,
  // relaunching, symlinking, and so on. That entire path was the
  // source of the "signed out but cookies kept" hybrid-state bug:
  // the destructive clone on every reconnect raced with real Chrome's
  // writes and the debug Chrome's account reconciler then cleared
  // Google sign-in metadata while leaving Cookies SQLite untouched.
  //
  // The new design moves all Chrome process + profile lifecycle into
  // `./chrome-lifecycle.ts`, which NEVER touches profile files — it
  // only spawns processes and opens profile windows in the already-
  // populated debug data dir. Full rationale in the top-of-file
  // comment of `chrome-lifecycle.ts`. Bootstrapping the debug dir
  // (one-time copy from real Chrome) is an explicit user-driven CLI
  // action that lives OUTSIDE the runtime and is not invoked here.

  /**
   * Absolute path to ohwow's debug Chrome user-data-dir. Exported
   * as a static for callers that used to reference
   * `LocalBrowserService.CHROME_DATA_DIR` — the new value points at
   * the debug dir, not the user's real Chrome. Callers that want to
   * enumerate profiles should use `discoverChromeProfiles()`, which
   * reads the debug dir's Local State via chrome-lifecycle.
   */
  static readonly CHROME_DATA_DIR = DEBUG_DATA_DIR;

  /**
   * Discover all Chrome profiles in ohwow's debug Chrome data-dir.
   * Returns the shape legacy callers expect (directory, name, email,
   * hostedDomain). Reads from Local State via chrome-lifecycle, which
   * is the same source Chrome's own profile picker uses.
   *
   * Note: previously this scanned the user's REAL Chrome data-dir.
   * It now scans the debug dir because that's where ohwow actually
   * drives Chrome from — the runtime has no business reaching into
   * the real profile store, and the old behavior was only ever used
   * to derive directory names that would then be re-cloned anyway.
   */
  static async discoverChromeProfiles(): Promise<Array<{
    directory: string;
    name: string;
    email: string;
    hostedDomain: string;
  }>> {
    try {
      const profiles = listProfiles();
      return profiles.map((p) => ({
        directory: p.directory,
        name: p.localProfileName ?? p.directory,
        email: p.email ?? '',
        // hostedDomain used to come from Chrome's `account_info[0].hosted_domain`
        // field. Local State doesn't carry that, and no current caller in the
        // ohwow codebase reads it. Derive from the email domain as a fallback
        // so legacy callers get a plausible value.
        hostedDomain: p.email && p.email.includes('@') ? p.email.split('@')[1] : '',
      }));
    } catch (err) {
      if (err instanceof ChromeLifecycleError && err.code === 'DEBUG_DIR_MISSING') {
        logger.warn(
          { path: DEBUG_DATA_DIR },
          '[browser] discoverChromeProfiles: debug dir missing, returning empty list',
        );
        return [];
      }
      throw err;
    }
  }

  /**
   * Find the Chrome profile directory that matches a given email or domain.
   * Returns the profile directory name (e.g. "Profile 1") or null.
   */
  /**
   * Resolve an email (or directory name, or local display name) to a
   * profile directory in ohwow's debug Chrome. Delegates to
   * `chrome-lifecycle.findProfileByIdentity`, which does the same
   * tiered match (exact email → exact dir → exact local name →
   * substring) and is unit-tested there.
   */
  static async findProfileForEmail(email: string): Promise<string | null> {
    try {
      const profiles = listProfiles();
      const match = findProfileByIdentity(profiles, email);
      return match ? match.directory : null;
    } catch (err) {
      if (err instanceof ChromeLifecycleError && err.code === 'DEBUG_DIR_MISSING') return null;
      throw err;
    }
  }

  /**
   * Connect to ohwow's debug Chrome via CDP. If the debug Chrome is
   * already running on the port, attach to it. Otherwise spawn a new
   * one against the existing `~/.ohwow/chrome-debug/` data dir (which
   * must already exist — bootstrapping is a separate one-time user
   * action, not runtime's business).
   *
   * Returns the CDP WebSocket URL on success, or null on any lifecycle
   * failure (missing debug dir, spawn failure, CDP timeout, consent
   * dialog pending). Callers fall back to bundled Chromium.
   *
   * Behavior changes from the pre-redesign version:
   *
   *   - NEVER wipes or re-clones the debug data dir. The old
   *     `_ensureDebugProfileDir` did `rm -rf ~/.ohwow/chrome-debug &&
   *     cp -cR ~/Library/.../Chrome ...` on every connect, which raced
   *     with real Chrome writes and corrupted Google sign-in state
   *     into the "signed out but cookies kept" hybrid state.
   *   - NEVER touches the user's real Chrome. The old code would
   *     osascript-quit it on every connect if it was running without
   *     CDP. The runtime no longer cares about real Chrome at all.
   *   - Profile MISMATCH is no longer a reason to quit + relaunch.
   *     If the running debug Chrome was launched with a different
   *     `--profile-directory`, we still return its CDP URL. Callers
   *     that want a specific profile should open a window for it via
   *     `chrome-lifecycle.openProfileWindow(profileDir)` rather than
   *     expecting the entire Chrome process to be on that profile.
   *
   * The `profileDir` parameter is kept for backcompat on the call
   * sites but is now advisory — it's only used as the preferred
   * profile if we have to spawn a fresh debug Chrome (and even then
   * it just picks which profile's window opens first).
   */
  static async connectToChrome(port = 9222, profileDir?: string): Promise<string | null> {
    try {
      const handle = await ensureDebugChrome({ port, preferredProfile: profileDir });
      await assertNoConsentPending(port);
      return handle.cdpWsUrl;
    } catch (err) {
      if (err instanceof ChromeLifecycleError) {
        logger.warn(
          { code: err.code, message: err.message, data: err.data },
          '[browser] connectToChrome failed',
        );
        return null;
      }
      throw err;
    }
  }

  // All Chrome process + profile lifecycle helpers that used to live
  // here (_probeCdp, _isChromeRunning, _findRealChromePids,
  // _findDebugChromePid, _getDebugChromeProfile, _quitDebugChrome,
  // _quitChrome, _killChrome, _chromeBinaryPath,
  // _ensureDebugProfileDir, _assertNoConsentPending,
  // _captureConsentScreenshot) have moved into `./chrome-lifecycle.ts`
  // or been deleted outright. Runtime no longer touches real Chrome,
  // never clones the user-data-dir, never wipes profile state. See
  // the top-of-file comment in chrome-lifecycle.ts for the full
  // rationale, and git history for the old implementations.

  // ==========================================================================
  // STAGEHAND AI METHODS
  // ==========================================================================

  async act(instruction: string): Promise<{ success: boolean; message: string }> {
    if (!this.stagehand) throw new Error('Browser not initialized');
    try {
      const result = await this.stagehand.act(instruction);
      return { success: result.success, message: result.message || 'Action completed' };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'act() failed' };
    }
  }

  async extract(instruction: string): Promise<string> {
    if (!this.stagehand) throw new Error('Browser not initialized');
    const result = await this.stagehand.extract(instruction);
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && 'extraction' in result) {
      return (result as { extraction: string }).extraction;
    }
    return JSON.stringify(result);
  }

  async observe(instruction?: string): Promise<Array<{ selector: string; description: string }>> {
    if (!this.stagehand) throw new Error('Browser not initialized');
    try {
      const result = await this.stagehand.observe(
        instruction || 'List all interactive elements on the page'
      );
      return result.map((r: { selector: string; description: string }) => ({
        selector: r.selector,
        description: r.description,
      }));
    } catch {
      return [];
    }
  }

  async agentTask(instruction: string, maxSteps = 10): Promise<AgentResult> {
    if (!this.stagehand) throw new Error('Browser not initialized');
    const agent = this.stagehand.agent({ model: this.modelName });
    return await agent.execute({
      instruction,
      maxSteps: Math.min(maxSteps, 20),
    });
  }

  // ==========================================================================
  // COOKIE OPERATIONS
  // ==========================================================================

  async injectCookies(
    cookies: Array<{ name: string; value: string; domain?: string; path?: string; url?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' }>
  ): Promise<number> {
    if (!this.ctx) throw new Error('Browser not initialized');
    await this.ctx.addCookies(cookies);
    return cookies.length;
  }

  async exportCookies(): Promise<Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' }>> {
    if (!this.ctx) throw new Error('Browser not initialized');
    return await this.ctx.cookies();
  }

  // ==========================================================================
  // ACTION DISPATCHER
  // ==========================================================================

  async executeAction(action: BrowserAction): Promise<BrowserActionResult> {
    try {
      const page = await this.ensureBrowser();

      switch (action.type) {
        case 'navigate':
          return await this.executeNavigate(page, action.url);
        case 'click':
          return await this.executeClick(page, action.ref, action.description);
        case 'type':
          return await this.executeType(page, action.ref, action.text, action.submit);
        case 'snapshot':
          return await this.executeSnapshot(page);
        case 'screenshot':
          return await this.executeScreenshot(page);
        case 'download':
          return await this.executeDownload(page, action.ref, action.description);
        case 'scroll':
          return await this.executeScroll(page, action.direction, action.amount);
        case 'back':
          await page.goBack({ timeout: 10000 }).catch(() => {});
          return { success: true, type: 'back', content: 'Navigated back', currentUrl: page.url() };
        case 'forward':
          await page.goForward({ timeout: 10000 }).catch(() => {});
          return { success: true, type: 'forward', content: 'Navigated forward', currentUrl: page.url() };
        case 'wait':
          return await this.executeWait(page, action.selector, action.timeout, action.state);
        case 'hover':
          return await this.executeHover(action.ref, action.description);
        case 'press_key':
          await page.keyboard.press(action.key);
          return { success: true, type: 'press_key', content: `Pressed key: ${action.key}` };
        case 'extract':
          return await this.executeExtract(action.instruction, action.schema);
        case 'extract_text':
          return await this.executeExtractText(page, action.selector, action.instruction);
        case 'agent_task':
          return await this.executeAgentTask(action.instruction, action.maxSteps);
        case 'click_at':
          await page.mouse.click(action.x, action.y);
          return { success: true, type: 'click_at', content: `Clicked at (${action.x}, ${action.y})` };
        case 'type_text':
          await page.keyboard.type(action.text);
          return { success: true, type: 'type_text', content: `Typed "${action.text.substring(0, 50)}"` };
        case 'new_tab':
          return await this.executeNewTab(action.url);
        case 'switch_tab':
          return await this.executeSwitchTab(action.tabIndex);
        case 'close_tab':
          return await this.executeCloseTab(action.tabIndex);
        case 'evaluate':
          return await this.executeEvaluate(page, action.expression);
        default:
          return { success: false, type: 'navigate', error: `Unknown action type: ${(action as { type: string }).type}` };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, type: action.type, error: errorMessage };
    }
  }

  // ==========================================================================
  // CORE ACTIONS
  // ==========================================================================

  private async executeNavigate(page: StagehandPage, url: string): Promise<BrowserActionResult> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return {
      success: true,
      type: 'navigate',
      content: `Navigated to ${page.url()} - "${await page.title()}"`,
      currentUrl: page.url(),
      pageTitle: await page.title(),
    };
  }

  // ==========================================================================
  // TAB MANAGEMENT
  // ==========================================================================

  private async executeNewTab(url?: string): Promise<BrowserActionResult> {
    if (!this.ctx) throw new Error('Browser not initialized');
    const newPage = await this.ctx.newPage();
    if (url) {
      await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    // Make the new tab the active page so subsequent ref-based actions
    // operate on it (matching the user's intuition that "open in new tab"
    // also focuses it).
    this.page = newPage;
    const pages = this.ctx.pages?.() || [];
    return {
      success: true,
      type: 'new_tab',
      content: url
        ? `Opened new tab #${pages.length - 1} at ${newPage.url()} - "${await newPage.title()}"`
        : `Opened new blank tab #${pages.length - 1}`,
      currentUrl: newPage.url(),
      pageTitle: await newPage.title(),
    };
  }

  private async executeSwitchTab(tabIndex: number): Promise<BrowserActionResult> {
    if (!this.ctx) throw new Error('Browser not initialized');
    const pages = this.ctx.pages?.() || [];
    if (tabIndex < 0 || tabIndex >= pages.length) {
      return {
        success: false,
        type: 'switch_tab',
        error: `Tab index ${tabIndex} out of range (0..${pages.length - 1}). Use browser_snapshot or browser_screenshot to see open tabs first.`,
      };
    }
    const target = pages[tabIndex];
    await target.bringToFront();
    this.page = target;
    return {
      success: true,
      type: 'switch_tab',
      content: `Switched to tab #${tabIndex} - ${target.url()}`,
      currentUrl: target.url(),
      pageTitle: await target.title(),
    };
  }

  // ==========================================================================
  // RAW JS EVALUATION
  // ==========================================================================

  /**
   * Execute a JS expression in the current page via Playwright's
   * page.evaluate(). This is the AI-free escape hatch for hostile-DOM
   * workflows where the orchestrator needs to introspect the live DOM
   * or trigger behavior that ref-based clicking can't reach.
   *
   * The expression runs in the BROWSER context (not Node), so it has
   * access to window, document, fetch, etc. It must return a
   * JSON-serializable value (object, array, string, number, null) — we
   * stringify it before shipping it back across the tool boundary.
   *
   * Safety: we cap the serialized result at 10 KB so a runaway
   * expression doesn't blow out the orchestrator's context window.
   * We also cap execution time at 15s via Playwright's default.
   */
  private async executeEvaluate(page: StagehandPage, expression: string): Promise<BrowserActionResult> {
    if (typeof expression !== 'string' || !expression.trim()) {
      return { success: false, type: 'evaluate', error: 'Missing or empty `expression` field. Pass a JS expression/snippet as a string.' };
    }
    try {
      // Playwright accepts either a function or a string expression. A
      // string runs via `Function('return (' + expr + ')')` so the user
      // can pass either a statement block or a single expression.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await page.evaluate(expression as any);
      let content: string;
      try {
        content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      } catch {
        content = String(result);
      }
      if (content.length > 10000) {
        content = content.slice(0, 10000) + `\n\n[truncated — result was ${content.length} bytes, showing first 10000]`;
      }
      return {
        success: true,
        type: 'evaluate',
        content,
        currentUrl: page.url(),
      };
    } catch (err) {
      return {
        success: false,
        type: 'evaluate',
        error: err instanceof Error ? err.message : 'evaluate failed',
      };
    }
  }

  private async executeCloseTab(tabIndex?: number): Promise<BrowserActionResult> {
    if (!this.ctx) throw new Error('Browser not initialized');
    const pages = this.ctx.pages?.() || [];
    if (pages.length === 0) {
      return { success: false, type: 'close_tab', error: 'No tabs open' };
    }
    const target = tabIndex === undefined ? this.page : pages[tabIndex];
    if (!target) {
      return {
        success: false,
        type: 'close_tab',
        error: `Tab index ${tabIndex} out of range (0..${pages.length - 1})`,
      };
    }
    const closedUrl = target.url();
    await target.close();
    // After closing, fall back to the first remaining page so subsequent
    // actions don't operate on a destroyed page handle.
    const remaining = this.ctx.pages?.() || [];
    this.page = remaining[0] || null;
    return {
      success: true,
      type: 'close_tab',
      content: `Closed tab "${closedUrl}". ${remaining.length} tab${remaining.length === 1 ? '' : 's'} remaining.`,
      currentUrl: this.page?.url(),
    };
  }

  private async executeClick(
    page: StagehandPage,
    ref: string,
    description?: string
  ): Promise<BrowserActionResult> {
    // Try AI-powered click first if description is available
    if (description) {
      const actResult = await this.act(`Click on: ${description}`);
      if (actResult.success) {
        return { success: true, type: 'click', content: actResult.message, currentUrl: page.url() };
      }
    }

    // Fall back to ref-based clicking
    const locator = page.locator(`[data-ref="${ref}"]`).first();
    const exists = await locator.count();

    if (exists === 0) {
      const refNum = parseInt(ref, 10);
      if (!isNaN(refNum)) {
        const allInteractive = page.locator(
          'a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]'
        );
        const count = await allInteractive.count();
        if (refNum >= 0 && refNum < count) {
          await allInteractive.nth(refNum).click({ timeout: 5000 });
          return {
            success: true,
            type: 'click',
            content: `Clicked element #${ref}${description ? ` (${description})` : ''}`,
          };
        }
      }
      return { success: false, type: 'click', error: `Element ref "${ref}" not found on page` };
    }

    await locator.click({ timeout: 5000 });
    return { success: true, type: 'click', content: `Clicked element ref="${ref}"` };
  }

  private async executeType(
    page: StagehandPage,
    ref: string,
    text: string,
    submit?: boolean
  ): Promise<BrowserActionResult> {
    const locator = page.locator(`[data-ref="${ref}"]`).first();
    const exists = await locator.count();

    if (exists === 0) {
      const refNum = parseInt(ref, 10);
      if (!isNaN(refNum)) {
        const inputs = page.locator('input, textarea, [contenteditable="true"]');
        const count = await inputs.count();
        if (refNum >= 0 && refNum < count) {
          await inputs.nth(refNum).fill(text);
          if (submit) await inputs.nth(refNum).press('Enter');
          return {
            success: true,
            type: 'type',
            content: `Typed "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" into input #${ref}${submit ? ' and submitted' : ''}`,
          };
        }
      }
      return { success: false, type: 'type', error: `Input element ref "${ref}" not found on page` };
    }

    await locator.fill(text);
    if (submit) await locator.press('Enter');
    return {
      success: true,
      type: 'type',
      content: `Typed "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" into ref="${ref}"${submit ? ' and submitted' : ''}`,
    };
  }

  private async executeSnapshot(page: StagehandPage): Promise<BrowserActionResult> {
    const snapshot = await this.getSnapshot(page);
    return {
      success: true,
      type: 'snapshot',
      content: snapshot.content,
      currentUrl: snapshot.url,
      pageTitle: snapshot.title,
    };
  }

  private async executeScreenshot(page: StagehandPage): Promise<BrowserActionResult> {
    const buffer = await page.screenshot({ type: 'jpeg', quality: 70 });
    return {
      success: true,
      type: 'screenshot',
      screenshot: buffer.toString('base64'),
      currentUrl: page.url(),
      pageTitle: await page.title(),
    };
  }

  private async executeDownload(
    page: StagehandPage,
    ref: string,
    description?: string
  ): Promise<BrowserActionResult> {
    const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        (async () => {
          const refNum = parseInt(ref, 10);
          if (!isNaN(refNum)) {
            const allInteractive = page.locator('a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]');
            const count = await allInteractive.count();
            if (refNum >= 0 && refNum < count) {
              await allInteractive.nth(refNum).click({ timeout: 5000 });
              return;
            }
          }
          await page.locator(`[data-ref="${ref}"]`).first().click({ timeout: 5000 });
        })(),
      ]);
      const filePath = await download.path();
      if (!filePath) return { success: false, type: 'download', error: 'Download failed' };
      const filename = download.suggestedFilename();
      const fs = await import('fs/promises');
      const fileBuffer = await fs.readFile(filePath);
      if (fileBuffer.length > MAX_DOWNLOAD_BYTES) {
        return { success: false, type: 'download', error: `File too large (${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB). Max: 25MB.` };
      }
      await download.delete().catch(() => {});
      return {
        success: true,
        type: 'download',
        content: `Downloaded "${filename}" (${(fileBuffer.length / 1024).toFixed(1)}KB)`,
        downloadBase64: fileBuffer.toString('base64'),
        downloadFilename: filename,
      };
    } catch (err) {
      return { success: false, type: 'download', error: `Download failed: ${err instanceof Error ? err.message : 'Unknown error'}${description ? ` (attempted: ${description})` : ''}` };
    }
  }

  // ==========================================================================
  // EXTENDED ACTIONS (new with Stagehand)
  // ==========================================================================

  private async executeScroll(page: StagehandPage, direction: 'up' | 'down', amount?: number): Promise<BrowserActionResult> {
    const pixels = amount || 400;
    const delta = direction === 'down' ? pixels : -pixels;
    await page.evaluate(`window.scrollBy(0, ${delta})`);
    return { success: true, type: 'scroll', content: `Scrolled ${direction} ${pixels}px` };
  }

  private async executeWait(page: StagehandPage, selector?: string, timeout?: number, state?: string): Promise<BrowserActionResult> {
    const ms = timeout || 5000;
    if (selector) {
      await page.waitForSelector(selector, { state: state || 'visible', timeout: ms });
      return { success: true, type: 'wait', content: `Element "${selector}" is ${state || 'visible'}` };
    }
    if (state === 'networkidle') {
      await page.waitForLoadState('networkidle', { timeout: ms });
      return { success: true, type: 'wait', content: 'Network idle' };
    }
    await new Promise(resolve => setTimeout(resolve, ms));
    return { success: true, type: 'wait', content: `Waited ${ms}ms` };
  }

  private async executeHover(ref?: string, description?: string): Promise<BrowserActionResult> {
    if (description) {
      const actResult = await this.act(`Hover over: ${description}`);
      if (actResult.success) return { success: true, type: 'hover', content: actResult.message };
    }
    if (ref) {
      const page = this.page;
      const locator = page.locator(`[data-ref="${ref}"]`).first();
      if (await locator.count() > 0) {
        await locator.hover();
        return { success: true, type: 'hover', content: `Hovered over ref="${ref}"` };
      }
      const refNum = parseInt(ref, 10);
      if (!isNaN(refNum)) {
        const all = page.locator('a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]');
        if (refNum < await all.count()) {
          await all.nth(refNum).hover();
          return { success: true, type: 'hover', content: `Hovered over element #${ref}` };
        }
      }
    }
    return { success: false, type: 'hover', error: 'No element found to hover' };
  }

  private async executeExtract(instruction: string, _schema?: string): Promise<BrowserActionResult> {
    try {
      const result = await this.extract(instruction);
      return { success: true, type: 'extract', content: result, currentUrl: this.page?.url() };
    } catch (err) {
      return { success: false, type: 'extract', error: err instanceof Error ? err.message : 'Extraction failed' };
    }
  }

  private async executeExtractText(page: StagehandPage, selector?: string, instruction?: string): Promise<BrowserActionResult> {
    if (instruction) {
      try {
        const result = await this.extract(instruction);
        return { success: true, type: 'extract_text', content: result };
      } catch { /* fall through to selector-based */ }
    }
    if (selector) {
      const text = await page.locator(selector).first().innerText().catch(() => '');
      return { success: true, type: 'extract_text', content: text };
    }
    const text = await page.evaluate(`document.body.innerText.substring(0, 5000)`);
    return { success: true, type: 'extract_text', content: text };
  }

  private async executeAgentTask(instruction: string, maxSteps?: number): Promise<BrowserActionResult> {
    try {
      const result = await this.agentTask(instruction, maxSteps || 10);
      return {
        success: true,
        type: 'agent_task',
        content: result.message || 'Agent task completed',
        currentUrl: this.page?.url(),
        pageTitle: this.page ? await this.page.title() : undefined,
      };
    } catch (err) {
      return { success: false, type: 'agent_task', error: err instanceof Error ? err.message : 'Agent task failed' };
    }
  }

  // ==========================================================================
  // ACCESSIBILITY SNAPSHOT
  // ==========================================================================

  async getSnapshot(page: StagehandPage): Promise<BrowserSnapshot> {
    const url = page.url();
    const title = await page.title();

    const snapshotFn = new Function(`
      const lines = [];
      let refCounter = 0;
      const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
      const interactiveRoles = new Set([
        'link', 'button', 'textbox', 'searchbox', 'combobox',
        'checkbox', 'radio', 'menuitem', 'tab', 'option',
      ]);
      function walk(node, depth) {
        const tag = node.tagName;
        const role = node.getAttribute('role') || '';
        const ariaLabel = node.getAttribute('aria-label') || '';
        const text = node.childNodes.length === 1 && node.childNodes[0].nodeType === 3
          ? (node.childNodes[0].textContent || '').trim().substring(0, 80)
          : '';
        const value = node.value || '';
        const indent = '  '.repeat(depth);
        const isInteractive = interactiveTags.has(tag) || interactiveRoles.has(role);
        const ref = isInteractive ? refCounter++ : -1;
        const displayRole = role || tag.toLowerCase();
        const displayName = ariaLabel || text || node.getAttribute('placeholder') || '';
        if (displayRole && displayRole !== 'div' && displayRole !== 'span') {
          let line = ref >= 0
            ? indent + '[' + ref + '] [' + displayRole + ']'
            : indent + '[' + displayRole + ']';
          if (displayName) line += ' "' + displayName + '"';
          if (value) line += ' value="' + value + '"';
          if (tag === 'A') {
            const href = node.getAttribute('href');
            if (href) line += ' href="' + href + '"';
          }
          lines.push(line);
        }
        for (const child of node.children) {
          walk(child, depth + (displayRole !== 'div' && displayRole !== 'span' ? 1 : 0));
        }
      }
      walk(document.body, 0);
      return lines.slice(0, 200).join('\\n') || '(empty page)';
    `) as () => string;
    const content = await page.evaluate(snapshotFn);

    return { url, title, content };
  }
}
