/**
 * Health Check Route
 * GET /health — Returns runtime status (no auth required)
 */

import { Router } from 'express';
import type Database from 'better-sqlite3';
import { VERSION } from '../../version.js';

export function createHealthRouter(startTime: number, db: Database.Database): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);

    // Quick DB check
    let dbOk = false;
    try {
      db.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      // DB not accessible
    }

    res.json({
      status: dbOk ? 'healthy' : 'degraded',
      uptime: uptimeSeconds,
      version: VERSION,
      database: dbOk ? 'ok' : 'error',
    });
  });

  return router;
}
