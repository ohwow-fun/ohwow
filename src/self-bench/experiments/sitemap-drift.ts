/**
 * SitemapDriftExperiment — guards the committed DASHBOARD_SITEMAP
 * against App.tsx drift.
 *
 * Reads src/web/src/App.tsx, parses every <Route path="…">, diffs
 * against DASHBOARD_SITEMAP. Fires `warning` with evidence pointing
 * at src/self-bench/dashboard-sitemap.ts when routes are missing
 * from the sitemap (App has more routes than the sitemap knows
 * about) OR stale (sitemap has routes that no longer exist in App).
 *
 * Why it matters: all downstream UI experiments (smoke, copy, a11y,
 * flow) iterate the sitemap. If App.tsx adds a new route and the
 * sitemap is stale, the new route is invisible to the self-UX loop
 * — drift means the loop silently stops covering fresh surface.
 *
 * Observe-only today; `dashboard-sitemap.ts` is not tier-2 yet so
 * the model can't author a fix. The finding lives in the ledger for
 * the operator to pick up. Once the file is promoted to a tier-1
 * append-only entry, patch-author can append missing routes on its
 * own — same pattern as toolchain-test-registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../lib/logger.js';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';
import {
  DASHBOARD_SITEMAP,
  APP_TSX_PATH,
  parseAppTsxRoutes,
  diffSitemap,
} from '../dashboard-sitemap.js';

const SITEMAP_FILE = 'src/self-bench/dashboard-sitemap.ts';

interface DriftEvidence extends Record<string, unknown> {
  repo_root: string | null;
  app_routes_count: number;
  sitemap_routes_count: number;
  missing: string[];
  stale: string[];
  affected_files: string[];
  reason?: string;
}

export class SitemapDriftExperiment implements Experiment {
  readonly id = 'sitemap-drift';
  readonly name = 'Dashboard sitemap vs App.tsx drift';
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis =
    'The committed DASHBOARD_SITEMAP reflects every <Route path> in ' +
    'App.tsx. Drift means the self-UX loop silently drops coverage on ' +
    'new pages or visits routes that no longer exist.';
  // 30min cadence: route changes are infrequent and a drift alert
  // doesn't need to be real-time.
  readonly cadence = { everyMs: 30 * 60 * 1000, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    if (!repoRoot) {
      const evidence: DriftEvidence = {
        repo_root: null,
        app_routes_count: 0,
        sitemap_routes_count: DASHBOARD_SITEMAP.length,
        missing: [],
        stale: [],
        affected_files: [],
        reason: 'no_repo_root',
      };
      return {
        subject: 'meta:sitemap-drift',
        summary: 'repo root not configured — skipping drift check',
        evidence,
      };
    }

    const appPath = path.join(repoRoot, APP_TSX_PATH);
    let source: string;
    try {
      source = fs.readFileSync(appPath, 'utf-8');
    } catch {
      const evidence: DriftEvidence = {
        repo_root: repoRoot,
        app_routes_count: 0,
        sitemap_routes_count: DASHBOARD_SITEMAP.length,
        missing: [],
        stale: [],
        affected_files: [],
        reason: 'app_tsx_missing',
      };
      return {
        subject: 'meta:sitemap-drift',
        summary: `${APP_TSX_PATH} not readable — skipping`,
        evidence,
      };
    }

    const appRoutes = parseAppTsxRoutes(source);
    const { missing, stale } = diffSitemap(appRoutes, DASHBOARD_SITEMAP);

    const evidence: DriftEvidence = {
      repo_root: repoRoot,
      app_routes_count: appRoutes.length,
      sitemap_routes_count: DASHBOARD_SITEMAP.length,
      missing,
      stale,
      affected_files: missing.length > 0 || stale.length > 0 ? [SITEMAP_FILE] : [],
    };
    const summary =
      missing.length === 0 && stale.length === 0
        ? `sitemap in sync with App.tsx (${appRoutes.length} routes)`
        : `sitemap drift: ${missing.length} missing, ${stale.length} stale`;
    return { subject: 'meta:sitemap-drift', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as DriftEvidence;
    if (ev.reason) return 'pass';
    if (ev.missing.length === 0 && ev.stale.length === 0) return 'pass';
    return 'warning';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    _ctx: ExperimentContext,
  ): Promise<null> {
    if (verdict !== 'warning') return null;
    const ev = result.evidence as DriftEvidence;
    logger.warn(
      {
        missing: ev.missing,
        stale: ev.stale,
        sitemapFile: SITEMAP_FILE,
      },
      '[sitemap-drift] dashboard sitemap out of sync with App.tsx',
    );
    return null;
  }
}
