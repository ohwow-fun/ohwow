/**
 * Desktop Session HTTP Router
 *
 * Exposes desktop screenshot capture and action execution as HTTP endpoints
 * so the cloud dashboard can display a live desktop viewer. Mirrors the
 * browser-session router pattern.
 *
 * Endpoints use /desktop/* prefix. /desktop/health is public; others require auth.
 */

import { Router } from 'express';
import {
  detectScreenInfo,
  captureAndScaleScreenshot,
  desktopLock,
} from '../../execution/desktop/index.js';
import { logger } from '../../lib/logger.js';

export function createDesktopSessionRouter(): Router {
  const router = Router();

  // --------------------------------------------------------------------------
  // Health — reports desktop availability and active session info
  // --------------------------------------------------------------------------
  router.get('/desktop/health', (_req, res) => {
    const holder = desktopLock.getHolder();
    res.json({
      ok: true,
      sessionActive: !!holder,
      activeAgentId: holder?.agentId ?? null,
      activeTaskId: holder?.taskId ?? null,
    });
  });

  // --------------------------------------------------------------------------
  // Screenshot — capture and return the current screen
  // ?format=raw  → returns raw JPEG bytes (Content-Type: image/jpeg)
  // Accept: image/* → same as format=raw
  // Otherwise    → returns JSON { screenshot (base64), width, height }
  // --------------------------------------------------------------------------
  router.get('/desktop/screenshot', async (req, res) => {
    try {
      const screenInfo = await detectScreenInfo();
      const { base64, scaledWidth, scaledHeight } = await captureAndScaleScreenshot(
        screenInfo,
        1280, // maxLongEdge
      );

      const acceptHeader = req.headers.accept || '';
      const wantsRaw = req.query.format === 'raw' || (acceptHeader.includes('image/') && !acceptHeader.includes('*/*'));
      if (wantsRaw) {
        const buf = Buffer.from(base64, 'base64');
        res.set('Content-Type', 'image/jpeg');
        res.set('X-Image-Width', String(scaledWidth));
        res.set('X-Image-Height', String(scaledHeight));
        res.send(buf);
        return;
      }

      res.json({
        screenshot: base64,
        width: scaledWidth,
        height: scaledHeight,
      });
    } catch (err) {
      logger.error({ err }, '[desktop-session] Screenshot capture failed');
      res.status(500).json({
        error: 'Screenshot capture failed',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // --------------------------------------------------------------------------
  // Action — execute a desktop action (click, type, key, scroll)
  // Requires an active desktop session (lock held by an agent)
  // --------------------------------------------------------------------------
  router.post('/desktop/action', async (req, res) => {
    const holder = desktopLock.getHolder();
    if (!holder) {
      res.status(409).json({ error: 'No active desktop session' });
      return;
    }

    const { type, x, y, text, key, direction, startX, startY, endX, endY, duration } = req.body;
    if (!type) {
      res.status(400).json({ error: 'Missing action type' });
      return;
    }

    try {
      // Import dynamically to avoid loading nut-js when not needed
      const { LocalDesktopService } = await import('../../execution/desktop/local-desktop.service.js');

      // Create a temporary service for the action (reuses the same nut-js instance)
      const service = new LocalDesktopService({ maxLongEdge: 1280 });
      const result = await service.executeAction({
        type,
        x, y,
        text,
        key,
        direction,
        startX, startY, endX, endY,
        duration,
      });

      res.json({
        success: !result.error,
        error: result.error ?? null,
        screenshot: result.screenshot ?? null,
        width: result.scaledWidth ?? null,
        height: result.scaledHeight ?? null,
      });
    } catch (err) {
      logger.error({ err }, '[desktop-session] Action execution failed');
      res.status(500).json({
        error: 'Action execution failed',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // --------------------------------------------------------------------------
  // Remote Action — execute a desktop action from the cloud orchestrator.
  // Does NOT require the desktop lock (the human user is controlling remotely).
  // --------------------------------------------------------------------------
  router.post('/desktop/remote-action', async (req, res) => {
    const { type, x, y, text, key, direction, amount, startX, startY, endX, endY, duration } = req.body;
    const ALLOWED_TYPES = new Set([
      'screenshot', 'left_click', 'right_click', 'double_click', 'triple_click',
      'type_text', 'typewrite', 'key', 'scroll', 'mouse_move', 'wait', 'left_click_drag',
    ]);
    if (!type || !ALLOWED_TYPES.has(type)) {
      res.status(400).json({ error: `Invalid action type: ${type || 'missing'}` });
      return;
    }

    try {
      const { LocalDesktopService } = await import('../../execution/desktop/local-desktop.service.js');
      const service = new LocalDesktopService({ maxLongEdge: 1280 });
      const result = await service.executeAction({
        type,
        x, y,
        text,
        key,
        direction,
        amount,
        startX, startY, endX, endY,
        duration,
      });

      res.json({
        success: !result.error,
        error: result.error ?? null,
        screenshot: result.screenshot ?? null,
        width: result.scaledWidth ?? null,
        height: result.scaledHeight ?? null,
        source: 'remote',
      });
    } catch (err) {
      logger.error({ err }, '[desktop-session] Remote action execution failed');
      res.status(500).json({
        error: 'Remote action execution failed',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  return router;
}
