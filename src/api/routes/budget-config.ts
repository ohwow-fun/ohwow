/**
 * Budget config routes — per-workspace knob for the gap-13 autonomous
 * LLM daily cap.
 *
 * GET /api/budget/limit
 *   Returns the current effective limit (USD), today's running autonomous
 *   spend, and the source the limit came from (`workspace.json` | `global`
 *   | `default`). The source field lets the UI say "this is set per
 *   workspace" vs "this is the install-wide default" without the user
 *   opening workspace.json themselves.
 *
 * PUT /api/budget/limit  { limitUsd: number }
 *   Writes `autonomousSpendLimitUsd` to the active workspace's
 *   workspace.json (creates the file for the default workspace if absent
 *   — legacy default workspaces have no workspace.json by convention).
 *   Refreshes the running engine's budget limit in-process so the next
 *   autonomous LLM call sees the new cap without a daemon restart. Cap
 *   bounds: strictly positive, ≤ 10_000 USD/day — the absolute ceiling
 *   catches "someone typed 100000" typos before they become expensive.
 *
 * Copywriting: validation errors are direct, no "please", no em dashes.
 */

import { Router } from 'express';
import type { RuntimeEngine } from '../../execution/engine.js';
import type { BudgetMeter } from '../../execution/budget-meter.js';
import {
  readWorkspaceConfig,
  resolveActiveWorkspace,
  writeWorkspaceConfig,
  type WorkspaceConfig,
  type WorkspaceMode,
} from '../../config.js';
import { DEFAULT_AUTONOMOUS_SPEND_LIMIT_USD } from '../../execution/budget-middleware.js';
import { logger } from '../../lib/logger.js';

export interface BudgetConfigRouterDeps {
  engine: RuntimeEngine | null;
  /** Resolved workspace row id (cloud UUID or 'local') for the cumulative-spend read. */
  workspaceId: string;
  /**
   * Install-wide limit as resolved by loadConfig(). Always populated (loadConfig
   * defaults to 50 USD when neither env nor global config supply a value), so
   * source='default' vs 'global' is distinguished by checking whether the env
   * var or global config.json actually set the field — see `globalLimitExplicit`.
   */
  globalLimitUsd?: number;
  /**
   * True when OHWOW_AUTONOMOUS_SPEND_LIMIT_USD (env) or
   * ~/.ohwow/config.json's autonomousSpendLimitUsd was explicitly set.
   * False when loadConfig fell back to the 50 USD default.
   */
  globalLimitExplicit?: boolean;
  /**
   * Current tier snapshot so the PUT handler can write a sensible default
   * `mode` when the default workspace has no workspace.json yet. Avoids
   * flipping the workspace's cloud/local-only state as a side-effect of
   * persisting a spend limit.
   */
  currentTier?: 'free' | 'connected';
  /** Current license key so a first-write preserves it in the new workspace.json. */
  currentLicenseKey?: string;
}

const MAX_LIMIT_USD = 10_000;

export function createBudgetConfigRouter(deps: BudgetConfigRouterDeps): Router {
  const router = Router();

  router.get('/api/budget/limit', async (_req, res) => {
    try {
      const activeWs = resolveActiveWorkspace();
      const wsCfg = readWorkspaceConfig(activeWs.name);
      const wsOverride = typeof wsCfg?.autonomousSpendLimitUsd === 'number' && wsCfg.autonomousSpendLimitUsd > 0
        ? wsCfg.autonomousSpendLimitUsd
        : undefined;

      let source: 'workspace.json' | 'global' | 'default';
      let limitUsd: number;
      if (wsOverride !== undefined) {
        source = 'workspace.json';
        limitUsd = wsOverride;
      } else if (deps.globalLimitExplicit && typeof deps.globalLimitUsd === 'number' && deps.globalLimitUsd > 0) {
        source = 'global';
        limitUsd = deps.globalLimitUsd;
      } else {
        source = 'default';
        limitUsd = deps.globalLimitUsd && deps.globalLimitUsd > 0
          ? deps.globalLimitUsd
          : DEFAULT_AUTONOMOUS_SPEND_LIMIT_USD;
      }

      let spentTodayUsd = 0;
      const meter: BudgetMeter | undefined = deps.engine?.budgetDeps?.meter;
      if (meter) {
        try {
          spentTodayUsd = await meter.getCumulativeAutonomousSpendUsd(deps.workspaceId);
        } catch (err) {
          // Meter read failure is non-fatal — report 0 and log. The
          // operator should still be able to see the limit even when
          // the meter is hiccuping.
          logger.warn({ err }, '[budget-config] meter read failed');
        }
      }

      res.json({
        data: {
          limitUsd,
          spentTodayUsd: Math.round(spentTodayUsd * 100) / 100,
          source,
          workspace: activeWs.name,
        },
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  router.put('/api/budget/limit', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { limitUsd?: unknown };
      const raw = body.limitUsd;
      const next = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(next) || next <= 0) {
        res.status(400).json({ error: 'limitUsd must be a positive number. Give it a value above zero.' });
        return;
      }
      if (next > MAX_LIMIT_USD) {
        res.status(400).json({ error: `limitUsd must be ${MAX_LIMIT_USD} or less.` });
        return;
      }

      const activeWs = resolveActiveWorkspace();
      const currentCfg = readWorkspaceConfig(activeWs.name);
      // Default workspace often has no workspace.json — inherit settings from
      // global config at write time so we don't flip mode/licenseKey just
      // because we added a spend-limit field.
      const inferredMode: WorkspaceMode = deps.currentTier === 'connected' ? 'cloud' : 'local-only';
      const baseCfg: WorkspaceConfig = currentCfg ?? {
        schemaVersion: 1,
        mode: inferredMode,
        ...(deps.currentLicenseKey ? { licenseKey: deps.currentLicenseKey } : {}),
      };
      const updated: WorkspaceConfig = { ...baseCfg, autonomousSpendLimitUsd: next };
      writeWorkspaceConfig(activeWs.name, updated);

      // Refresh the in-process engine's budget limit so the next
      // autonomous call sees the new cap without a daemon restart.
      // setBudgetDeps is the same entry point daemon/init.ts uses at
      // boot; re-invoke with the same deps and the new limit.
      const engine = deps.engine;
      if (engine?.budgetDeps) {
        engine.setBudgetDeps(engine.budgetDeps, next);
      }

      logger.info(
        { workspace: activeWs.name, limitUsd: next },
        '[budget-config] autonomous spend limit updated',
      );

      res.json({
        data: {
          limitUsd: next,
          source: 'workspace.json',
          workspace: activeWs.name,
        },
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  return router;
}
