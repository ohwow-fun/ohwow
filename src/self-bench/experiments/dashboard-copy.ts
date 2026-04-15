/**
 * DashboardCopyExperiment — scans the rendered text of every
 * smokeable dashboard route for copywriting-rule violations.
 *
 * Pairs with src/lib/copy-rules-linter.ts (detectors) and the
 * self-bench browser primitive (headless Chromium). Per route:
 *   1. Navigate, wait for network idle.
 *   2. Scrape visible text via document.body.innerText.
 *   3. Apply COPY_RULES; collect violations with route + rule-id
 *      + match + surrounding context so a human or patch-author
 *      can find the string in source.
 *
 * Emits one fail finding per tick if any route has any violation,
 * with evidence.per_route[].violations and evidence.affected_files
 * mapped from route family → page component file (shared map with
 * dashboard-smoke).
 *
 * Observe-only. The autonomous copy-fix path (tier-2-copy + the
 * string-literal patch mode) ships in Sprint 2.5 after we see what
 * the finding corpus actually looks like.
 */

import { logger } from '../../lib/logger.js';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import {
  smokeableRoutes,
  type SitemapEntry,
} from '../dashboard-sitemap.js';
import {
  dashboardUrlForWorkspace,
  resolveActiveWorkspace,
} from '../../config.js';
import {
  injectLocalSession,
  readLocalSessionToken,
  withPage,
} from '../browser/self-bench-browser.js';
import { lintCopy, type CopyViolation } from '../../lib/copy-rules-linter.js';
import { DASHBOARD_SMOKE_FAMILY_TO_PAGE_FILE } from './dashboard-smoke.js';

const NAV_TIMEOUT_MS = 15_000;
const SETTLE_MS = 400;
/** Upper bound on violations recorded per route to keep evidence bounded. */
const MAX_VIOLATIONS_PER_ROUTE = 30;
/** Chars of surrounding context included with each violation. */
const CONTEXT_CHARS = 60;

export interface RouteCopyResult {
  route: string;
  family: string;
  violations: Array<CopyViolation & { context: string }>;
  textLength: number;
  loadMs: number;
  /** Populated when the page failed to load — causes no violations. */
  navError?: string;
}

interface CopyEvidence extends Record<string, unknown> {
  workspace: string;
  dashboard_base: string | null;
  routes_walked: number;
  routes_with_violations: number;
  total_violations: number;
  per_route: RouteCopyResult[];
  affected_files: string[];
  reason?: string;
}

export class DashboardCopyExperiment implements Experiment {
  readonly id = 'dashboard-copy';
  readonly name = 'Dashboard copy-rules linter';
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis =
    'Every user-facing string rendered by the dashboard passes the ' +
    'machine-checkable subset of the copywriting rules in CLAUDE.md.';
  // 15min — same shape as dashboard-smoke but a bit slower since
  // copy violations are about human perception, not uptime.
  readonly cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const workspace = resolveActiveWorkspace().name;
    const base = dashboardUrlForWorkspace(workspace);
    if (!base) {
      const evidence: CopyEvidence = {
        workspace,
        dashboard_base: null,
        routes_walked: 0,
        routes_with_violations: 0,
        total_violations: 0,
        per_route: [],
        affected_files: [],
        reason: 'no_dashboard_url',
      };
      return {
        subject: 'meta:dashboard-copy',
        summary: `no port for workspace ${workspace}; skipping`,
        evidence,
      };
    }

    const token = readLocalSessionToken(workspace);
    const routes = smokeableRoutes();

    let perRoute: RouteCopyResult[] = [];
    try {
      perRoute = await withPage(async (page) => {
        if (token) await injectLocalSession(page, token);
        const results: RouteCopyResult[] = [];
        for (const route of routes) {
          results.push(await walkOne(page, base, route));
        }
        return results;
      });
    } catch (err) {
      const evidence: CopyEvidence = {
        workspace,
        dashboard_base: base,
        routes_walked: 0,
        routes_with_violations: 0,
        total_violations: 0,
        per_route: [],
        affected_files: [],
        reason: `browser_error: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
      };
      return {
        subject: 'meta:dashboard-copy',
        summary: 'browser failed to boot — see reason',
        evidence,
      };
    }

    const withViolations = perRoute.filter((r) => r.violations.length > 0);
    const totalViolations = perRoute.reduce((n, r) => n + r.violations.length, 0);
    const affectedFiles = unique(
      withViolations
        .map((r) => DASHBOARD_SMOKE_FAMILY_TO_PAGE_FILE[r.family])
        .filter((f): f is string => typeof f === 'string'),
    );

    const evidence: CopyEvidence = {
      workspace,
      dashboard_base: base,
      routes_walked: perRoute.length,
      routes_with_violations: withViolations.length,
      total_violations: totalViolations,
      per_route: perRoute,
      affected_files: affectedFiles,
    };
    const summary =
      totalViolations === 0
        ? `${perRoute.length} route(s) walked, 0 copy violations`
        : `${totalViolations} violation(s) across ${withViolations.length}/${perRoute.length} route(s)`;
    return { subject: 'meta:dashboard-copy', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as CopyEvidence;
    if (ev.reason) return 'pass';
    return ev.total_violations === 0 ? 'pass' : 'fail';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    _ctx: ExperimentContext,
  ): Promise<null> {
    if (verdict !== 'fail') return null;
    const ev = result.evidence as CopyEvidence;
    const samples = ev.per_route
      .filter((r) => r.violations.length > 0)
      .slice(0, 3)
      .map((r) => ({
        route: r.route,
        violations: r.violations.slice(0, 3).map((v) => ({
          rule: v.ruleId,
          match: v.match,
          context: v.context,
        })),
      }));
    logger.warn(
      {
        totalViolations: ev.total_violations,
        routesWithViolations: ev.routes_with_violations,
        samples,
      },
      '[dashboard-copy] copy-rule violations observed',
    );
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function walkOne(page: any, base: string, route: SitemapEntry): Promise<RouteCopyResult> {
  const t0 = Date.now();
  let text = '';
  let navError: string | undefined;
  try {
    await page.goto(`${base}${route.url}`, {
      waitUntil: 'networkidle',
      timeout: NAV_TIMEOUT_MS,
    });
    await page.waitForTimeout(SETTLE_MS);
    // innerText gives rendered visible text (respects display:none,
    // collapses scripts/styles). Body may be null on a crashed page.
    text = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (globalThis as any).document?.body;
      return body ? String(body.innerText ?? '') : '';
    });
  } catch (err) {
    navError = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  }

  const raw = text ? lintCopy(text) : [];
  const violations = raw.slice(0, MAX_VIOLATIONS_PER_ROUTE).map((v) => ({
    ...v,
    context: makeContext(text, v.index, v.match.length),
  }));

  return {
    route: route.url,
    family: route.family,
    violations,
    textLength: text.length,
    loadMs: Date.now() - t0,
    ...(navError ? { navError } : {}),
  };
}

function makeContext(text: string, index: number, len: number): string {
  const start = Math.max(0, index - CONTEXT_CHARS);
  const end = Math.min(text.length, index + len + CONTEXT_CHARS);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + slice + (end < text.length ? '…' : '');
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
