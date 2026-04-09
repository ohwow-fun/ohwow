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

export function createBrowserSessionRouter(options?: { headless?: boolean }): Router {
  configuredHeadless = options?.headless ?? false;
  const router = Router();

  // --------------------------------------------------------------------------
  // Health check (no auth — checked before session creation)
  // --------------------------------------------------------------------------

  router.get('/browser/health', (_req, res) => {
    const service = getOrCreateService();
    res.json({
      ok: true,
      initialized: service.isActive(),
      browserResponsive: service.isActive(),
      headless: configuredHeadless,
    });
  });

  // --------------------------------------------------------------------------
  // Session start — launch browser
  // --------------------------------------------------------------------------

  router.post('/browser/session/start', async (req, res) => {
    try {
      const { modelName, modelApiKey } = req.body || {};
      const service = getOrCreateService({ modelName, modelApiKey });
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

  router.get('/browser/session/export-cookies', async (_req, res) => {
    try {
      const service = getOrCreateService();
      const cookies = await service.exportCookies();
      res.json({ cookies });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cookie export failed';
      logger.error({ err }, '[BrowserSession] /session/export-cookies failed');
      res.status(500).json({ success: false, error: message });
    }
  });

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
