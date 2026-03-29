/**
 * Anomaly Monitoring — Detection and alerting wrapper
 *
 * Extracted from RuntimeEngine. Wraps the anomaly detection pipeline
 * (build profile, detect anomalies, persist alerts) into a single
 * fire-and-forget function for both success and failure paths.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { buildBehaviorProfileLocal, detectAnomaliesLocal, persistAlertsLocal } from '../lib/anomaly-detector.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AnomalyCheckOpts {
  db: DatabaseAdapter;
  agentId: string;
  workspaceId: string;
  taskId: string;
  tokensUsed: number;
  durationSeconds: number;
  failed: boolean;
  toolsUsed: string[];
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Build a behavior profile for an agent, detect anomalies in the current
 * task result, and persist any alerts. This is designed to be called in a
 * fire-and-forget pattern (non-fatal on errors).
 */
export async function detectAndPersistAnomalies(opts: AnomalyCheckOpts): Promise<void> {
  const { db, agentId, workspaceId, taskId, tokensUsed, durationSeconds, failed, toolsUsed } = opts;

  try {
    const profile = await buildBehaviorProfileLocal(db, agentId);
    if (profile) {
      const alerts = detectAnomaliesLocal(
        { taskId, tokensUsed, durationSeconds, failed, truthScore: null, toolsUsed },
        profile,
      );
      if (alerts.length > 0) {
        await persistAlertsLocal(db, workspaceId, alerts);
      }
    }
  } catch (err) {
    logger.debug({ err }, '[anomaly-monitoring] Anomaly detection skipped');
  }
}
