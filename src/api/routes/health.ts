/**
 * Health Check Route
 * GET /health — Returns runtime status with BPP vitals (no auth required)
 */

import { Router } from 'express';
import type Database from 'better-sqlite3';
import { VERSION } from '../../version.js';

/** Optional BPP system references for biological vitals reporting. */
export interface HealthBppDeps {
  homeostasis?: { getOverallDeviation(): number } | null;
  sleepCycle?: { getState(): { phase: string; sleepDebt: number } } | null;
  affect?: { getState(): { dominant: string; valence: number; arousal: number } } | null;
  endocrine?: { getProfile(): { overallTone: string } } | null;
  synapseHealth?: () => Promise<number>;
}

export function createHealthRouter(
  startTime: number,
  db: Database.Database,
  bppDeps?: HealthBppDeps,
): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);

    // Quick DB check
    let dbOk = false;
    try {
      db.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      // DB not accessible
    }

    // BPP vitals (all optional — omitted if module not loaded)
    const bpp: Record<string, unknown> = {};
    if (bppDeps) {
      try {
        if (bppDeps.homeostasis) {
          bpp.homeostasis_deviation = bppDeps.homeostasis.getOverallDeviation();
        }
        if (bppDeps.sleepCycle) {
          const sleep = bppDeps.sleepCycle.getState();
          bpp.sleep_phase = sleep.phase;
          bpp.sleep_debt = sleep.sleepDebt;
        }
        if (bppDeps.affect) {
          const affect = bppDeps.affect.getState();
          bpp.affect_dominant = affect.dominant;
          bpp.affect_valence = affect.valence;
        }
        if (bppDeps.endocrine) {
          bpp.endocrine_tone = bppDeps.endocrine.getProfile().overallTone;
        }
        if (bppDeps.synapseHealth) {
          bpp.synapse_health = await bppDeps.synapseHealth();
        }
      } catch { /* BPP vitals are non-fatal */ }
    }

    res.json({
      status: dbOk ? 'healthy' : 'degraded',
      uptime: uptimeSeconds,
      version: VERSION,
      database: dbOk ? 'ok' : 'error',
      ...(Object.keys(bpp).length > 0 ? { bpp } : {}),
    });
  });

  return router;
}
