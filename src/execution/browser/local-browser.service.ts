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

  constructor(opts?: LocalBrowserServiceOptions) {
    this.headless = opts?.headless !== false; // default headless
    this.modelName = opts?.modelName || this.resolveDefaultModel();
    this.modelApiKey = opts?.modelApiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    this.cdpUrl = opts?.cdpUrl;
  }

  private resolveDefaultModel(): string {
    if (process.env.ANTHROPIC_API_KEY) return 'anthropic/claude-sonnet-4-5';
    if (process.env.OPENAI_API_KEY) return 'openai/gpt-4o-mini';
    return 'openai/gpt-4o-mini'; // Stagehand default
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  async ensureBrowser(): Promise<StagehandPage> {
    if (this.page) return this.page;

    try {
      const { Stagehand } = await loadStagehand();
      const launchOpts: Record<string, unknown> = this.cdpUrl
        ? { cdpUrl: this.cdpUrl }
        : { headless: this.headless };
      logger.debug(`[browser] Stagehand.init — ${this.cdpUrl ? `cdp: ${this.cdpUrl}` : `headless: ${this.headless}`}, model: ${this.modelName}`);
      this.stagehand = new Stagehand({
        env: 'LOCAL',
        localBrowserLaunchOptions: launchOpts,
        model: this.modelName,
        verbose: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await this.stagehand.init();
      this.ctx = this.stagehand.context;
      this.page = this.ctx.activePage();
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
   * Connect to the user's real Chrome browser via Chrome DevTools Protocol.
   * Optionally launches Chrome with a specific profile directory.
   * Returns the CDP WebSocket URL for Stagehand to connect to.
   */
  static async connectToChrome(port = 9222, profileDir?: string): Promise<string> {
    const cdpHttpUrl = `http://localhost:${port}`;

    // Check if Chrome is already running with remote debugging
    try {
      const res = await fetch(`${cdpHttpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json() as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) {
          logger.info(`[browser] Connected to existing Chrome CDP at port ${port}`);
          return data.webSocketDebuggerUrl;
        }
      }
    } catch {
      // Not running with CDP — need to (re)launch
    }

    // Chrome can't enable CDP retroactively — if it's running without the flag,
    // we need to restart it. Use graceful quit (AppleScript on macOS) so Chrome
    // saves the session and restores tabs on relaunch.
    const { exec, spawn } = await import('child_process');
    const platform = process.platform;

    const isRunning = await new Promise<boolean>((resolve) => {
      exec(platform === 'darwin' ? 'pgrep -x "Google Chrome"' : 'pgrep -x chrome', (err) => resolve(!err));
    });

    if (isRunning) {
      logger.info('[browser] Chrome is running without CDP. Restarting gracefully (tabs will be restored)...');
      if (platform === 'darwin') {
        // AppleScript graceful quit — Chrome saves session and restores tabs on relaunch
        await new Promise<void>((resolve) => {
          exec('osascript -e \'tell application "Google Chrome" to quit\'', () => resolve());
        });
      } else {
        await new Promise<void>((resolve) => {
          exec('pkill -x chrome', () => resolve());
        });
      }
      // Wait for Chrome to fully close
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        const stillRunning = await new Promise<boolean>((resolve) => {
          exec(platform === 'darwin' ? 'pgrep -x "Google Chrome"' : 'pgrep -x chrome', (err) => resolve(!err));
        });
        if (!stillRunning) break;
      }
    }

    const profileFlag = profileDir ? `--profile-directory=${profileDir}` : '';
    let chromeBin: string;
    if (platform === 'darwin') {
      chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    } else if (platform === 'win32') {
      chromeBin = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    } else {
      chromeBin = 'google-chrome';
    }

    const args = [`--remote-debugging-port=${port}`];
    if (profileFlag) args.push(profileFlag);

    logger.info(`[browser] Launching Chrome: ${chromeBin} ${args.join(' ')}`);
    const child = spawn(chromeBin, args, { detached: true, stdio: 'ignore' });
    child.unref();

    // Wait for CDP port to be ready (up to 15s)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const res = await fetch(`${cdpHttpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const data = await res.json() as { webSocketDebuggerUrl?: string };
          if (data.webSocketDebuggerUrl) {
            logger.info(`[browser] Chrome launched with CDP on port ${port}${profileDir ? ` (profile: ${profileDir})` : ''}`);
            return data.webSocketDebuggerUrl;
          }
        }
      } catch { /* retry */ }
    }

    throw new Error(`Chrome didn't start with remote debugging on port ${port}. Try launching Chrome manually with: "${chromeBin}" --remote-debugging-port=${port}`);
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
