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
 * Sync getter — returns the existing service, or a bare bundled-Chromium
 * service if none has been created yet. Used by health checks and any route
 * that runs after /session/start has already initialized things.
 */
function getOrCreateService(opts?: { modelName?: string; modelApiKey?: string }): LocalBrowserService {
  if (!browserService) {
    browserService = new LocalBrowserService({
      headless: configuredHeadless,
      modelName: opts?.modelName,
      modelApiKey: opts?.modelApiKey,
    });
  }
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
      res.json({ success: true });
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
      const service = getOrCreateService();
      if (!service.isActive()) {
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
      const service = getOrCreateService();
      const page = service.getPage();
      if (!page) {
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
      const service = getOrCreateService();
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
      const service = getOrCreateService();
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
  const exportCookiesHandler = async (_req: import('express').Request, res: import('express').Response) => {
    try {
      const service = getOrCreateService();
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
      const service = getOrCreateService();
      await service.close();
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Browser close failed';
      logger.error({ err }, '[BrowserSession] /session/close failed');
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
