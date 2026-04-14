/**
 * Self-findings Route
 *
 * GET /api/findings
 *   List self_findings rows produced by the self-bench ExperimentRunner.
 *   Supports filtering by experiment_id, category, verdict, subject, and
 *   status. Defaults to active status, newest-first, capped at 50 rows.
 *   The upper cap is 500.
 *
 * This is the query surface for the ledger every experiment writes into.
 * It backs ohwow_list_findings (MCP) and any future operator dashboard.
 * Workspace scoping is not applied here because self_findings itself
 * is daemon-global (one daemon owns one workspace; all findings belong
 * to that workspace by the process boundary).
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { listFindings } from '../../self-bench/findings-store.js';
import type {
  ExperimentCategory,
  FindingStatus,
  Verdict,
} from '../../self-bench/experiment-types.js';

function asCategory(raw: unknown): ExperimentCategory | undefined {
  if (typeof raw !== 'string') return undefined;
  const valid: ExperimentCategory[] = [
    'model_health',
    'trigger_stability',
    'tool_reliability',
    'handler_audit',
    'prompt_calibration',
    'canary',
    'other',
  ];
  return valid.includes(raw as ExperimentCategory) ? (raw as ExperimentCategory) : undefined;
}

function asVerdict(raw: unknown): Verdict | undefined {
  if (typeof raw !== 'string') return undefined;
  const valid: Verdict[] = ['pass', 'warning', 'fail', 'error'];
  return valid.includes(raw as Verdict) ? (raw as Verdict) : undefined;
}

function asStatus(raw: unknown): FindingStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  const valid: FindingStatus[] = ['active', 'superseded', 'revoked'];
  return valid.includes(raw as FindingStatus) ? (raw as FindingStatus) : undefined;
}

export function createFindingsRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.get('/api/findings', async (req, res) => {
    try {
      const experimentId = typeof req.query.experiment_id === 'string'
        ? req.query.experiment_id
        : undefined;
      const subject = typeof req.query.subject === 'string'
        ? req.query.subject
        : undefined;
      const category = asCategory(req.query.category);
      const verdict = asVerdict(req.query.verdict);
      const status = asStatus(req.query.status);
      const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
      const limit = limitRaw && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;

      const findings = await listFindings(db, {
        experimentId,
        subject,
        category,
        verdict,
        status,
        limit,
      });

      res.json({ data: findings, count: findings.length, limit });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
