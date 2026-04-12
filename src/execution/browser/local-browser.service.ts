/**
 * Local Browser Service
 * Wraps Stagehand v3 for AI-powered local Chromium browser automation.
 * Provides the same capabilities as the cloud browser package (act, extract,
 * agent_task) but runs on the user's machine with their residential IP.
 */

import type {
  BrowserAction,
  BrowserActionResult,
  BrowserSnapshot,
} from './browser-types.js';
import { logger } from '../../lib/logger.js';

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
  /** CDP WebSocket URL to connect to an existing browser (e.g. real Chrome). When set, Stagehand connects via CDP instead of launching Chromium. */
  cdpUrl?: string;
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
  private cdpUrl: string | undefined;
  private initPromise: Promise<StagehandPage> | null = null;

  constructor(opts?: LocalBrowserServiceOptions) {
    this.headless = opts?.headless !== false; // default headless
    // Order: explicit opts → Anthropic → OpenAI → OpenRouter.
    // Stagehand AI tools (act, extract, observe, agent) need a real
    // LLM backend — they call a model under the hood. If no key is
    // available, AI tools will fail at runtime but Playwright-direct
    // tools (navigate, click, type, snapshot, screenshot) still work.
    const resolved = this.resolveDefaultModel();
    this.modelName = opts?.modelName || resolved.model;
    this.modelApiKey = opts?.modelApiKey || resolved.apiKey || '';
    this.cdpUrl = opts?.cdpUrl;
  }

  private resolveDefaultModel(): { model: string; apiKey: string } {
    // Stagehand's Vercel aiSDK integration only accepts specific provider
    // names. Supported: openai, anthropic, google, bedrock, xai, azure,
    // groq, cerebras, togetherai, mistral, deepseek, perplexity, ollama,
    // vertex, gateway. It does NOT accept 'openrouter' — attempting to use
    // it throws "openrouter is not currently supported for aiSDK" and
    // breaks every browser tool call, not just AI ones.
    if (process.env.ANTHROPIC_API_KEY) {
      return { model: 'anthropic/claude-sonnet-4-5', apiKey: process.env.ANTHROPIC_API_KEY };
    }
    if (process.env.OPENAI_API_KEY) {
      return { model: 'openai/gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY };
    }
    if (process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      return { model: 'google/gemini-2.0-flash-exp', apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY || '' };
    }
    // No supported key available. Stagehand AI tools (act/extract/observe/
    // agent) will fail at call time, but Playwright-direct tools (navigate/
    // click/type/snapshot/screenshot/evaluate) still work.
    return { model: 'openai/gpt-4o-mini', apiKey: '' };
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
      const { Stagehand } = await loadStagehand();
      const launchOpts: Record<string, unknown> = this.cdpUrl
        ? { cdpUrl: this.cdpUrl }
        : { headless: this.headless };
      logger.debug(`[browser] Stagehand.init — ${this.cdpUrl ? `cdp: ${this.cdpUrl}` : `headless: ${this.headless}`}, model: ${this.modelName}, apiKey: ${this.modelApiKey ? 'set' : 'MISSING — extract/act/agent will fail'}`);
      // Stagehand v3 expects the API key via modelClientOptions (not
      // process.env) so we can honour whatever credential resolution the
      // rest of the daemon does.
      const modelClientOptions: Record<string, unknown> = {};
      if (this.modelApiKey) modelClientOptions.apiKey = this.modelApiKey;
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

  async close(): Promise<void> {
    try {
      if (this.stagehand) await this.stagehand.close().catch(() => {});
    } finally {
      this.stagehand = null;
      this.page = null;
      this.ctx = null;
    }
  }

  // ==========================================================================
  // CHROME CDP CONNECTION
  // ==========================================================================

  /** Chrome profile info discovered from the filesystem */
  static readonly CHROME_DATA_DIR = process.platform === 'darwin'
    ? `${process.env.HOME}/Library/Application Support/Google/Chrome`
    : process.platform === 'win32'
      ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`
      : `${process.env.HOME}/.config/google-chrome`;

  /**
   * Discover all Chrome profiles on this machine.
   * Returns profile directory names, display names, and associated email accounts.
   */
  static async discoverChromeProfiles(): Promise<Array<{
    directory: string;
    name: string;
    email: string;
    hostedDomain: string;
  }>> {
    const { readFileSync, existsSync, readdirSync } = await import('fs');
    const { join } = await import('path');
    const chromeDir = LocalBrowserService.CHROME_DATA_DIR;

    if (!existsSync(chromeDir)) return [];

    const profiles: Array<{ directory: string; name: string; email: string; hostedDomain: string }> = [];
    const dirs = readdirSync(chromeDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && (d.name === 'Default' || d.name.startsWith('Profile ')))
      .map(d => d.name);

    for (const dir of dirs) {
      const prefsPath = join(chromeDir, dir, 'Preferences');
      if (!existsSync(prefsPath)) continue;
      try {
        const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));
        const name = prefs.profile?.name || dir;
        const accounts = prefs.account_info || [];
        const primary = accounts[0] || {};
        profiles.push({
          directory: dir,
          name,
          email: primary.email || '',
          hostedDomain: primary.hosted_domain || '',
        });
      } catch { /* skip corrupt profiles */ }
    }

    return profiles;
  }

  /**
   * Find the Chrome profile directory that matches a given email or domain.
   * Returns the profile directory name (e.g. "Profile 1") or null.
   */
  static async findProfileForEmail(email: string): Promise<string | null> {
    const profiles = await LocalBrowserService.discoverChromeProfiles();
    const domain = email.split('@')[1];

    // Exact email match first
    const exact = profiles.find(p => p.email === email);
    if (exact) return exact.directory;

    // Domain match
    const domainMatch = profiles.find(p => p.hostedDomain === domain || p.email.endsWith(`@${domain}`));
    if (domainMatch) return domainMatch.directory;

    return null;
  }

  /**
   * Connect to the user's real Chrome via CDP. If Chrome isn't already exposing
   * CDP, this will quit any running Chrome and relaunch it with debugging enabled,
   * pointing at the user's real profile (so cookies/logins are preserved).
   *
   * Returns the CDP WebSocket URL on success, or null if we couldn't get CDP up
   * (caller should fall back to bundled Chromium).
   *
   * Why this is non-trivial: Chrome 136+ silently disables `--remote-debugging-port`
   * when launched against the default user-data-dir as a security measure. We work
   * around this by setting up `~/.ohwow/chrome-debug/` as a non-default user-data-dir
   * containing a symlink to the real profile directory — Chrome accepts the debugging
   * port, and the symlink keeps cookies/sessions live.
   */
  static async connectToChrome(port = 9222, profileDir?: string): Promise<string | null> {
    const cdpHttpUrl = `http://localhost:${port}`;

    // 1. Fast path: Chrome is already running with CDP.
    const existing = await LocalBrowserService._probeCdp(cdpHttpUrl);
    if (existing) {
      logger.info(`[browser] Connected to existing Chrome CDP at port ${port}`);
      await LocalBrowserService._assertNoConsentPending(cdpHttpUrl);
      return existing;
    }

    const platform = process.platform;
    const { exec, spawn } = await import('child_process');

    // 2. If Chrome is running (without CDP), quit it. We can't enable debugging
    //    on a running instance, so we have to relaunch.
    if (await LocalBrowserService._isChromeRunning(exec, platform)) {
      logger.info('[browser] Chrome is running without CDP — quitting to relaunch with debugging');
      await LocalBrowserService._quitChrome(exec, platform);
      if (await LocalBrowserService._isChromeRunning(exec, platform)) {
        logger.warn('[browser] Chrome did not respond to graceful quit, sending SIGTERM');
        await LocalBrowserService._killChrome(exec, platform);
      }
      if (await LocalBrowserService._isChromeRunning(exec, platform)) {
        logger.warn('[browser] Chrome still running after SIGTERM — aborting CDP setup');
        return null;
      }
    }

    // 3. Set up a non-default user-data-dir with a symlink to the real profile.
    //    The symlink lets us keep cookies/sessions live while sidestepping
    //    Chrome's default-user-data-dir debugging restriction.
    const effectiveProfile = profileDir || 'Default';
    const debugDataDir = await LocalBrowserService._ensureDebugProfileDir(effectiveProfile);
    if (!debugDataDir) return null;

    // 4. Launch Chrome with debugging enabled.
    const chromeBin = LocalBrowserService._chromeBinaryPath(platform);
    const args = [
      `--user-data-dir=${debugDataDir}`,
      `--profile-directory=${effectiveProfile}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];

    logger.info(`[browser] Launching Chrome with profile "${effectiveProfile}" on debug port ${port}`);
    try {
      const child = spawn(chromeBin, args, { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[browser] Failed to spawn Chrome');
      return null;
    }

    // 5. Poll for CDP availability (10s budget). Process running ≠ port bound.
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const wsUrl = await LocalBrowserService._probeCdp(cdpHttpUrl);
      if (wsUrl) {
        logger.info(`[browser] Chrome CDP ready on port ${port} (profile: ${effectiveProfile})`);
        // Give Chrome a moment to render any first-run dialogs (managed
        // profile notice, keychain prompt) before checking.
        await new Promise(r => setTimeout(r, 1500));
        await LocalBrowserService._assertNoConsentPending(cdpHttpUrl);
        return wsUrl;
      }
    }

    logger.warn('[browser] Chrome launched but CDP did not become ready within 10s');
    return null;
  }

  /**
   * Chrome 147 shows a "managed user profile notice" the first time a Google-
   * signed-in profile is launched from a non-default user-data-dir. Until the
   * user clicks "Continue" on that dialog, Chrome refuses to load auth cookies
   * from the profile. We detect that pending state by checking the open tabs
   * via /json/list, and throw an actionable error so the orchestrator can tell
   * the user exactly what to click.
   *
   * If desktop screen capture is available (macOS), we also grab a screenshot
   * of the dialog and embed it in the error so the chat reply can show the
   * user exactly which button to press. The screenshot is base64-prefixed in
   * the error message after a sentinel marker so the cloud can parse it out.
   */
  private static async _assertNoConsentPending(cdpHttpUrl: string): Promise<void> {
    try {
      const res = await fetch(`${cdpHttpUrl}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return;
      const tabs = await res.json() as Array<{ url?: string; type?: string }>;
      const hasNotice = tabs.some(t =>
        typeof t.url === 'string' && t.url.startsWith('chrome://managed-user-profile-notice'),
      );
      if (hasNotice) {
        const screenshotMarker = await LocalBrowserService._captureConsentScreenshot();
        throw new Error(
          'CHROME_CONSENT_PENDING: Chrome opened your real profile but is waiting for one-time consent. ' +
          'Switch to the Chrome window showing "Your organization will be able to view some information" ' +
          'and click Continue, then ask me again. (Chrome blocks auth cookies from loading until you accept.)' +
          screenshotMarker,
        );
      }
    } catch (err) {
      // Re-throw the consent error; swallow any unrelated fetch failures.
      if (err instanceof Error && err.message.startsWith('CHROME_CONSENT_PENDING:')) throw err;
    }
  }

  /**
   * Best-effort desktop screenshot of the consent dialog (macOS only). Returns
   * an empty string if capture fails or is unavailable on this platform — we
   * never want screenshot failure to mask the underlying CONSENT_PENDING.
   *
   * The format is `\n\n[CONSENT_SCREENSHOT_BASE64]\n<base64>` so callers can
   * parse the data URL out of the error message without breaking the
   * human-readable prefix.
   */
  private static async _captureConsentScreenshot(): Promise<string> {
    if (process.platform !== 'darwin') return '';
    try {
      const { detectScreenInfo, captureAndScaleScreenshot } = await import('../desktop/screenshot-capture.js');
      const screenInfo = detectScreenInfo();
      const { base64 } = await captureAndScaleScreenshot(screenInfo, 1280);
      return `\n\n[CONSENT_SCREENSHOT_BASE64]\n${base64}`;
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : err }, '[browser] consent screenshot capture failed');
      return '';
    }
  }

  // ----- CDP helpers -----

  private static async _probeCdp(cdpHttpUrl: string): Promise<string | null> {
    try {
      const res = await fetch(`${cdpHttpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const data = await res.json() as { webSocketDebuggerUrl?: string };
      return data.webSocketDebuggerUrl || null;
    } catch {
      return null;
    }
  }

  /**
   * Detect ONLY the user's "real" Chrome — the one running against their default
   * Chrome user-data-dir. Stagehand and Playwright/MCP Chromes use temp profile
   * dirs (e.g. /tmp/, /var/folders/.../stagehand-v3, /Library/Caches/ms-playwright/),
   * and we must never touch those, since the daemon and our test harness depend on
   * them.
   */
  private static _isChromeRunning(
    exec: typeof import('child_process').exec,
    platform: NodeJS.Platform,
  ): Promise<boolean> {
    if (platform === 'win32') {
      return new Promise(resolve => exec('tasklist /FI "IMAGENAME eq chrome.exe" | findstr chrome.exe', (err) => resolve(!err)));
    }
    return LocalBrowserService._findRealChromePids(exec, platform).then(pids => pids.length > 0);
  }

  private static _findRealChromePids(
    exec: typeof import('child_process').exec,
    platform: NodeJS.Platform,
  ): Promise<number[]> {
    const pgrepCmd = platform === 'darwin'
      ? 'pgrep -f "Google Chrome.app/Contents/MacOS/Google Chrome"'
      : 'pgrep -f "google-chrome|/chrome "';
    return new Promise(resolve => {
      exec(pgrepCmd, (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const pids = stdout.trim().split('\n').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
        if (pids.length === 0) return resolve([]);
        // For each pid, check its argv: only count it as "real Chrome" if it
        // does NOT have --user-data-dir pointing at a temp/test profile dir.
        Promise.all(pids.map(pid => new Promise<{ pid: number; isReal: boolean }>(res => {
          exec(`ps -o command= -p ${pid}`, (e, out) => {
            if (e || !out) return res({ pid, isReal: false });
            const cmd = out.trim();
            // Skip if it's a helper subprocess (renderer, GPU, etc).
            if (/--type=/.test(cmd)) return res({ pid, isReal: false });
            const dirMatch = cmd.match(/--user-data-dir=([^ ]+)/);
            const userDataDir = dirMatch ? dirMatch[1] : '';
            const isTempProfile = !!userDataDir && (
              userDataDir.includes('/stagehand-v3') ||
              userDataDir.includes('/ms-playwright') ||
              userDataDir.includes('/.ohwow/chrome-debug') ||
              userDataDir.startsWith('/tmp/') ||
              userDataDir.startsWith('/var/folders/')
            );
            // Real Chrome = main process, not a helper, not a test/temp profile.
            res({ pid, isReal: !isTempProfile });
          });
        }))).then(rows => resolve(rows.filter(r => r.isReal).map(r => r.pid)));
      });
    });
  }

  private static async _quitChrome(
    exec: typeof import('child_process').exec,
    platform: NodeJS.Platform,
  ): Promise<void> {
    if (platform === 'win32') {
      await new Promise<void>(resolve => exec('taskkill /IM chrome.exe', () => resolve()));
    } else if (platform === 'darwin') {
      await new Promise<void>(resolve => exec(`osascript -e 'tell application "Google Chrome" to quit'`, () => resolve()));
    } else {
      // Linux: signal only the real-Chrome pids we identified, leaving Stagehand alone.
      const pids = await LocalBrowserService._findRealChromePids(exec, platform);
      if (pids.length > 0) {
        await new Promise<void>(resolve => exec(`kill -TERM ${pids.join(' ')}`, () => resolve()));
      }
    }
    // Give Chrome up to 5s to exit cleanly.
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (!(await LocalBrowserService._isChromeRunning(exec, platform))) return;
    }
  }

  private static async _killChrome(
    exec: typeof import('child_process').exec,
    platform: NodeJS.Platform,
  ): Promise<void> {
    if (platform === 'win32') {
      await new Promise<void>(resolve => exec('taskkill /F /IM chrome.exe', () => resolve()));
    } else {
      // Only signal the user's real Chrome, never Stagehand/Playwright Chromes.
      const pids = await LocalBrowserService._findRealChromePids(exec, platform);
      if (pids.length > 0) {
        await new Promise<void>(resolve => exec(`kill -TERM ${pids.join(' ')}`, () => resolve()));
      }
    }
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (!(await LocalBrowserService._isChromeRunning(exec, platform))) return;
    }
  }

  private static _chromeBinaryPath(platform: NodeJS.Platform): string {
    if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    return 'google-chrome';
  }

  /**
   * Create `~/.ohwow/chrome-debug/` as a fresh clonefile copy of the user's
   * entire Chrome user-data-dir, and return the path for --user-data-dir.
   *
   * Why a full copy instead of a symlink to just the profile:
   *
   * Chrome's per-user-data-dir state is NOT self-contained in Profile N/.
   * A symlinked profile gives you the subdirectory contents (preferences,
   * history, cached-ish things) but Chrome at the enclosing user-data-dir:
   *
   *   - writes a fresh Local State file containing encrypted master keys,
   *     so the profile's cookies can't decrypt
   *   - considers the Google sign-in state invalid because the enclosing
   *     user-data-dir has no record of past sign-ins
   *   - forces a "Your organization will..." managed-profile consent flow
   *     for enterprise profiles, and even after clicking Continue the
   *     auth cookies remain inaccessible
   *   - doesn't find the other sibling profiles (user sees "this Chrome
   *     doesn't have all my profiles")
   *
   * The result: user thinks the real Chrome profile opened but actually it's
   * an empty shell that looks like the right profile directory. The X login
   * page shows, DMs are inaccessible, etc.
   *
   * A full clonefile copy (APFS copy-on-write) of the whole user-data-dir
   * sidesteps all of this: Local State, all profiles, encrypted cookie keys,
   * everything comes along. On APFS it's near-instant and near-zero disk.
   * On non-APFS we fall back to a regular recursive copy.
   *
   * We always start from a clean target so the debug Chrome reflects the
   * CURRENT state of the real Chrome every time the daemon connects (the
   * user's latest logins, history, etc).
   */
  private static async _ensureDebugProfileDir(profile: string): Promise<string | null> {
    const { existsSync } = await import('fs');
    const { rm, mkdir } = await import('fs/promises');
    const path = await import('path');
    const { exec } = await import('child_process');

    const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
    const debugDataDir = path.join(homeDir, '.ohwow', 'chrome-debug');
    const realDataDir = LocalBrowserService.CHROME_DATA_DIR;
    const realProfilePath = path.join(realDataDir, profile);

    if (!existsSync(realProfilePath)) {
      logger.warn(`[browser] Chrome profile not found: ${realProfilePath} (available profiles will be listed below)`);
      // Best-effort list of what IS available so users/callers can course-correct.
      try {
        const { readdir } = await import('fs/promises');
        const entries = await readdir(realDataDir, { withFileTypes: true });
        const profiles = entries
          .filter(e => e.isDirectory() && (e.name === 'Default' || e.name.startsWith('Profile ')))
          .map(e => e.name);
        logger.warn(`[browser] Available Chrome profiles: ${profiles.join(', ') || '(none)'}`);
      } catch { /* ignore */ }
      return null;
    }

    // Always wipe and re-copy so the debug Chrome reflects the user's
    // current real state. Clonefile on APFS makes this cheap.
    try {
      await rm(debugDataDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[browser] Failed to wipe old debug profile dir');
    }

    try {
      // Make sure the parent exists but the target itself does not (cp -c
      // refuses to overwrite an existing target).
      await mkdir(path.dirname(debugDataDir), { recursive: true });

      const copyStart = Date.now();
      const cpResult = await new Promise<{ code: number; err?: string }>((resolve) => {
        // cp -c = clonefile (APFS copy-on-write, near-instant + zero disk)
        // cp -R = recursive
        // Source has a trailing slash-free form; we want to copy the directory
        // itself to the new name, so pass source WITHOUT trailing slash and
        // dest WITHOUT existing target.
        exec(`cp -cR ${JSON.stringify(realDataDir)} ${JSON.stringify(debugDataDir)}`, (err, _stdout, stderr) => {
          if (err) return resolve({ code: 1, err: stderr || err.message });
          resolve({ code: 0 });
        });
      });

      if (cpResult.code !== 0) {
        // APFS clonefile may not be available (non-APFS volume, different
        // filesystems); fall back to a regular recursive copy.
        logger.info({ err: cpResult.err }, '[browser] cp -c (clonefile) failed, falling back to cp -R');
        const fallbackResult = await new Promise<{ code: number; err?: string }>((resolve) => {
          exec(`cp -R ${JSON.stringify(realDataDir)} ${JSON.stringify(debugDataDir)}`, (err, _stdout, stderr) => {
            if (err) return resolve({ code: 1, err: stderr || err.message });
            resolve({ code: 0 });
          });
        });
        if (fallbackResult.code !== 0) {
          logger.warn({ err: fallbackResult.err }, '[browser] cp -R also failed');
          return null;
        }
      }

      logger.info(`[browser] Cloned real Chrome user-data-dir to ${debugDataDir} in ${Date.now() - copyStart}ms`);

      // Sanity check: the requested profile must exist in the copy.
      if (!existsSync(path.join(debugDataDir, profile))) {
        logger.warn(`[browser] Debug copy is missing profile ${profile}; refusing to launch`);
        return null;
      }

      return debugDataDir;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[browser] Failed to set up debug profile dir');
      return null;
    }
  }

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
