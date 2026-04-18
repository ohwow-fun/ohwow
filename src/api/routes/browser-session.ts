/**
 * Browser Session HTTP Router
 *
 * Exposes the local browser (Playwright) as an HTTP API matching the contract
 * the cloud dashboard's callBrowserMachine() expects. This lets the cloud route
 * browser sessions through the user's local machine for residential IP access.
 *
 * Endpoints use /browser/* prefix. /browser/health is public; all others require auth.
 */

import { Router } from 'express';
import { LocalBrowserService } from '../../execution/browser/local-browser.service.js';
import { logger } from '../../lib/logger.js';

/** Singleton browser service — lazily created on first /session/start */
let browserService: LocalBrowserService | null = null;
let configuredHeadless = false;

/**
 * Tear down the singleton browser service. Called from the daemon shutdown
 * handler so any Stagehand-spawned Chromium child process exits cleanly
 * instead of being orphaned across daemon restarts.
 *
 * Stagehand v3 logs a warning at init time about lacking a "shutdown
 * supervisor" — that supervisor is what would normally clean up child
 * processes if the daemon dies unexpectedly. We can't install Stagehand's
 * supervisor as a library consumer, so the best we can do is explicitly
 * call close() on graceful shutdown.
 */
export async function closeBrowserSessionService(): Promise<void> {
  if (!browserService) return;
  try {
    await browserService.close();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, '[BrowserSession] Singleton close failed');
  } finally {
    browserService = null;
  }
}

/**
 * Sync getter — returns the existing service, or null. IMPORTANT: this must
 * NEVER create a fresh LocalBrowserService. If a cleanup/mutation route is
 * called before /session/start, creating a bare bundled-Chromium singleton
 * here would "win" and /session/start would skip the smart Chrome CDP
 * launcher — making every subsequent tool call run on isolated Chromium
 * with no real profile, and the orchestrator would hallucinate "I opened
 * X with your session" when it actually has an anonymous browser.
 *
 * Only /session/start is allowed to create the singleton, via
 * ensureBrowserService() below.
 */
function getBrowserService(): LocalBrowserService | null {
  return browserService;
}

/**
 * Async ensurer — used by /session/start. If the user has Chrome running with
 * CDP (or we can launch one with the right profile), connect to it so the
 * session uses their real cookies/logins. Otherwise fall back to bundled
 * Chromium.
 */
async function ensureBrowserService(opts?: {
  modelName?: string;
  modelApiKey?: string;
  chromeProfile?: string;
  preferRealChrome?: boolean;
}): Promise<LocalBrowserService> {
  if (browserService) return browserService;

  let cdpUrl: string | undefined;
  if (opts?.preferRealChrome !== false) {
    try {
      const found = await LocalBrowserService.connectToChrome(9222, opts?.chromeProfile);
      if (found) {
        cdpUrl = found;
        logger.info('[BrowserSession] Using real Chrome via CDP');
      }
    } catch (err) {
      // CHROME_CONSENT_PENDING is actionable — propagate it to the caller so
      // the orchestrator can tell the user exactly what to click. Other
      // failures fall through to bundled Chromium.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('CHROME_CONSENT_PENDING:')) throw err;
      logger.warn(
        { err: msg },
        '[BrowserSession] Chrome CDP setup failed, falling back to bundled Chromium',
      );
    }
  }

  browserService = new LocalBrowserService({
    headless: cdpUrl ? false : configuredHeadless,
    modelName: opts?.modelName,
    modelApiKey: opts?.modelApiKey,
    cdpUrl,
    // This route already probed CDP above. When cdpUrl is undefined we
    // either chose not to try (preferRealChrome === false) or the probe
    // failed — either way, skip the default re-probe inside the service.
    forceBundled: !cdpUrl,
  });
  return browserService;
}

export function createBrowserSessionRouter(options?: { headless?: boolean }): Router {
  configuredHeadless = options?.headless ?? false;
  const router = Router();

  // --------------------------------------------------------------------------
  // Health check (no auth — checked before session creation)
  // --------------------------------------------------------------------------

  router.get('/browser/health', (_req, res) => {
    // Don't create a service here — this is called on every cloud session
    // start to probe runtime availability. Creating a bare LocalBrowserService
    // here would defeat the lazy CDP setup in /session/start.
    res.json({
      ok: true,
      initialized: !!browserService && browserService.isActive(),
      browserResponsive: !!browserService && browserService.isActive(),
      headless: configuredHeadless,
      browserBackend: browserService?.getBackend() ?? 'uninitialized',
    });
  });

  // --------------------------------------------------------------------------
  // Session start — launch browser
  // --------------------------------------------------------------------------

  router.post('/browser/session/start', async (req, res) => {
    try {
      const { modelName, modelApiKey, chromeProfile, preferRealChrome } = req.body || {};
      // Profile can be specified by the caller, or via OHWOW_CHROME_PROFILE
      // env var, or defaults to 'Default'. The CDP fast-path doesn't care
      // about this when Chrome is already running with debug port enabled.
      const effectiveProfile = chromeProfile || process.env.OHWOW_CHROME_PROFILE || undefined;
      const service = await ensureBrowserService({
        modelName,
        modelApiKey,
        chromeProfile: effectiveProfile,
        preferRealChrome,
      });
      await service.ensureBrowser();
      // Expose the actual backend in the response so the cloud can tell
      // whether this session is driving real Chrome (with user cookies) or
      // isolated Chromium. Prevents the orchestrator from hallucinating
      // "opened in your real Chrome session" when it's really anonymous.
      res.json({ success: true, browserBackend: service.getBackend() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Browser launch failed';
      logger.error({ err }, '[BrowserSession] /session/start failed');
      res.status(500).json({ success: false, error: message });
    }
  });

  // --------------------------------------------------------------------------
  // Execute action (navigate, click, type, snapshot, screenshot, download)
  // --------------------------------------------------------------------------

  router.post('/browser/session/action', async (req, res) => {
    try {
      const service = getBrowserService();
      if (!service || !service.isActive()) {
        res.status(400).json({ error: 'Browser not initialized. Call /session/start first.' });
        return;
      }

      const action = req.body;
      if (!action?.type) {
        res.status(400).json({ error: 'Missing action type' });
        return;
      }

      // The local service supports: navigate, click, type, snapshot, screenshot, download
      const result = await service.executeAction(action);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action execution failed';
      logger.error({ err }, '[BrowserSession] /session/action failed');
      res.status(500).json({ success: false, error: message });
    }
  });

  // --------------------------------------------------------------------------
  // Snapshot — accessibility tree
  // --------------------------------------------------------------------------

  router.get('/browser/session/snapshot', async (_req, res) => {
    try {
      const service = getBrowserService();
      const page = service?.getPage();
      if (!service || !page) {
        res.status(400).json({ error: 'Browser not initialized. Call /session/start first.' });
        return;
      }

      const snapshot = await service.getSnapshot(page);
      res.json({
        success: true,
        type: 'snapshot',
        content: snapshot.content,
        currentUrl: snapshot.url,
        pageTitle: snapshot.title,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Snapshot failed';
      logger.error({ err }, '[BrowserSession] /session/snapshot failed');
      res.status(500).json({ success: false, error: message });
    }
  });

  // --------------------------------------------------------------------------
  // Screenshot
  // --------------------------------------------------------------------------

  router.get('/browser/session/screenshot', async (_req, res) => {
    try {
      const service = getBrowserService();
      if (!service || !service.isActive()) {
        res.status(400).json({ error: 'Browser not initialized. Call /session/start first.' });
        return;
      }
      const result = await service.executeAction({ type: 'screenshot' });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Screenshot failed';
      logger.error({ err }, '[BrowserSession] /session/screenshot failed');
      res.status(500).json({ success: false, error: message });
    }
  });

  // --------------------------------------------------------------------------
  // Cookie inject
  // --------------------------------------------------------------------------

  router.post('/browser/session/inject-cookies', async (req, res) => {
    try {
      const service = getBrowserService();
      if (!service || !service.isActive()) {
        res.status(400).json({ error: 'Browser not initialized. Call /session/start first.' });
        return;
      }
      const cookies = req.body?.cookies;
      if (!Array.isArray(cookies)) {
        res.status(400).json({ error: 'Missing cookies array in request body' });
        return;
      }

      const injected = await service.injectCookies(cookies);
      res.json({ success: true, injected });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cookie injection failed';
      logger.error({ err }, '[BrowserSession] /session/inject-cookies failed');
      res.status(500).json({ success: false, error: message });
    }
  });

  // --------------------------------------------------------------------------
  // Cookie export
  // --------------------------------------------------------------------------

  // Support both GET (for ad-hoc inspection) and POST (matches the cloud's
  // expectation that all mutating session endpoints are POST).
  // IMPORTANT: never auto-create a service here. The cloud calls this during
  // stale-session cleanup BEFORE /session/start fires; auto-creating would
  // spawn a bundled-Chromium singleton and defeat the smart Chrome launcher
  // that /session/start would otherwise run. If there's no active browser,
  // just return an empty cookies list — cleanup is a no-op.
  const exportCookiesHandler = async (_req: import('express').Request, res: import('express').Response) => {
    try {
      const service = getBrowserService();
      if (!service || !service.isActive()) {
        res.json({ cookies: [] });
        return;
      }
      const cookies = await service.exportCookies();
      res.json({ cookies });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cookie export failed';
      logger.error({ err }, '[BrowserSession] /session/export-cookies failed');
      res.status(500).json({ success: false, error: message });
    }
  };
  router.get('/browser/session/export-cookies', exportCookiesHandler);
  router.post('/browser/session/export-cookies', exportCookiesHandler);

  // --------------------------------------------------------------------------
  // Close browser
  // --------------------------------------------------------------------------

  router.post('/browser/session/close', async (_req, res) => {
    try {
      // Never auto-create here either. If the cloud calls close on a session
      // that was never /session/start'd on this daemon, treat as no-op.
      const service = getBrowserService();
      if (!service) {
        res.json({ success: true });
        return;
      }
      await service.close();
      browserService = null;
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Browser close failed';
      logger.error({ err }, '[BrowserSession] /session/close failed');
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
