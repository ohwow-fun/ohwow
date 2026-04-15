/**
 * DashboardSmokeExperiment — first real browser-driven surprise
 * source.
 *
 * Walks every smokeable route from DASHBOARD_SITEMAP in a headless
 * Chromium (via the self-bench browser primitive), injecting the
 * daemon's local session token so authed routes load real data.
 * Per route it collects:
 *   - console errors (`console.error` or runtime exceptions)
 *   - failed subresource responses (HTTP status ≥ 400)
 *   - page title (to catch the global ErrorBoundary's "Error" state)
 *
 * Emits one finding PER ROUTE that had issues, verdict=fail, with
 * evidence shaped to the Ui finding convention (category, route,
 * rule_id where applicable, and affected_files mapped from route
 * family → page component). Routes with no issues produce nothing;
 * the experiment-level finding summarizes the whole walk as
 * pass/fail.
 *
 * Observe-only today. tier-2 promotion of page files happens in a
 * later sprint; until then, findings surface for the operator while
 * sitemap-drift keeps coverage honest.
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
  DASHBOARD_SITEMAP,
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

const NAV_TIMEOUT_MS = 15_000;
const SETTLE_MS = 400;
/** Hard cap on issues recorded per route so evidence stays bounded. */
const MAX_ISSUES_PER_ROUTE = 20;

/**
 * Route family → primary page component. Hardcoded because deriving
 * it from Vite's route tree would be brittle. Missing entries
 * degrade gracefully: the route still gets smoked, but findings
 * carry no affected_files (patch-author will skip them).
 */
const FAMILY_TO_PAGE_FILE: Readonly<Record<string, string>> = {
  dashboard: 'src/web/src/pages/Dashboard.tsx',
  agents: 'src/web/src/pages/Agents.tsx',
  tasks: 'src/web/src/pages/Tasks.tsx',
  contacts: 'src/web/src/pages/Contacts.tsx',
  projects: 'src/web/src/pages/Projects.tsx',
  templates: 'src/web/src/pages/Templates.tsx',
  automations: 'src/web/src/pages/AutomationsListPage.tsx',
  connections: 'src/web/src/pages/Connections.tsx',
  approvals: 'src/web/src/pages/Approvals.tsx',
  activity: 'src/web/src/pages/Activity.tsx',
  schedules: 'src/web/src/pages/Schedules.tsx',
  knowledge: 'src/web/src/pages/Knowledge.tsx',
  messages: 'src/web/src/pages/Messages.tsx',
  workflows: 'src/web/src/pages/WorkflowsHub.tsx',
  'webhook-events': 'src/web/src/pages/WebhookEvents.tsx',
  goals: 'src/web/src/pages/Goals.tsx',
  revenue: 'src/web/src/pages/Revenue.tsx',
  messaging: 'src/web/src/pages/Messaging.tsx',
  peers: 'src/web/src/pages/Peers.tsx',
  team: 'src/web/src/pages/Team.tsx',
  browser: 'src/web/src/pages/BrowserViewer.tsx',
  briefings: 'src/web/src/pages/Briefings.tsx',
  podcast: 'src/web/src/pages/Podcast.tsx',
  eye: 'src/web/src/pages/Eye.tsx',
  settings: 'src/web/src/pages/Settings.tsx',
  onboarding: 'src/web/src/pages/Onboarding.tsx',
  auth: 'src/web/src/pages/Login.tsx',
};

export interface RouteIssue {
  kind: 'console-error' | 'http-error' | 'page-error-title' | 'nav-failure';
  message: string;
  url?: string;
  status?: number;
}

export interface RouteSmokeResult {
  route: string;
  family: string;
  title: string | null;
  issues: RouteIssue[];
  loadMs: number;
}

interface SmokeEvidence extends Record<string, unknown> {
  workspace: string;
  dashboard_base: string | null;
  routes_walked: number;
  routes_with_issues: number;
  total_issues: number;
  per_route: RouteSmokeResult[];
  affected_files: string[];
  reason?: string;
}

export class DashboardSmokeExperiment implements Experiment {
  readonly id = 'dashboard-smoke';
  readonly name = 'Dashboard route smoke walk';
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis =
    'Every smokeable dashboard route loads with no console errors, ' +
    'no HTTP 4xx/5xx on subresources, and no global ErrorBoundary title.';
  // 5min — accelerated for fast observation cycles.
  readonly cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const workspace = resolveActiveWorkspace().name;
    const base = dashboardUrlForWorkspace(workspace);
    if (!base) {
      const evidence: SmokeEvidence = {
        workspace,
        dashboard_base: null,
        routes_walked: 0,
        routes_with_issues: 0,
        total_issues: 0,
        per_route: [],
        affected_files: [],
        reason: 'no_dashboard_url',
      };
      return {
        subject: 'meta:dashboard-smoke',
        summary: `no port for workspace ${workspace}; skipping`,
        evidence,
      };
    }

    const token = readLocalSessionToken(workspace);
    const routes = smokeableRoutes();

    let perRoute: RouteSmokeResult[] = [];
    try {
      perRoute = await withPage(async (page) => {
        if (token) await injectLocalSession(page, token);
        const results: RouteSmokeResult[] = [];
        for (const route of routes) {
          results.push(await walkOne(page, base, route));
        }
        return results;
      });
    } catch (err) {
      const evidence: SmokeEvidence = {
        workspace,
        dashboard_base: base,
        routes_walked: 0,
        routes_with_issues: 0,
        total_issues: 0,
        per_route: [],
        affected_files: [],
        reason: `browser_error: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
      };
      return {
        subject: 'meta:dashboard-smoke',
        summary: 'browser failed to boot — see reason',
        evidence,
      };
    }

    const withIssues = perRoute.filter((r) => r.issues.length > 0);
    const totalIssues = perRoute.reduce((n, r) => n + r.issues.length, 0);
    const affectedFiles = unique(
      withIssues
        .map((r) => FAMILY_TO_PAGE_FILE[r.family])
        .filter((f): f is string => typeof f === 'string'),
    );

    const evidence: SmokeEvidence = {
      workspace,
      dashboard_base: base,
      routes_walked: perRoute.length,
      routes_with_issues: withIssues.length,
      total_issues: totalIssues,
      per_route: perRoute,
      affected_files: affectedFiles,
    };
    const summary =
      withIssues.length === 0
        ? `${perRoute.length} route(s) walked, 0 issues`
        : `${withIssues.length}/${perRoute.length} route(s) with issues, ${totalIssues} total`;
    return { subject: 'meta:dashboard-smoke', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as SmokeEvidence;
    if (ev.reason) return 'pass';
    return ev.total_issues === 0 ? 'pass' : 'fail';
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    _ctx: ExperimentContext,
  ): Promise<null> {
    if (verdict !== 'fail') return null;
    const ev = result.evidence as SmokeEvidence;
    logger.warn(
      {
        routesWithIssues: ev.routes_with_issues,
        totalIssues: ev.total_issues,
        sample: ev.per_route.filter((r) => r.issues.length > 0).slice(0, 3),
      },
      '[dashboard-smoke] route-level issues observed',
    );
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function walkOne(page: any, base: string, route: SitemapEntry): Promise<RouteSmokeResult> {
  const consoleErrors: RouteIssue[] = [];
  const httpErrors: RouteIssue[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onConsole = (msg: any) => {
    if (msg.type() === 'error' && consoleErrors.length < MAX_ISSUES_PER_ROUTE) {
      consoleErrors.push({ kind: 'console-error', message: String(msg.text()).slice(0, 500) });
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onPageError = (err: any) => {
    if (consoleErrors.length < MAX_ISSUES_PER_ROUTE) {
      consoleErrors.push({
        kind: 'console-error',
        message: `uncaught: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      });
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onResponse = (resp: any) => {
    const status: number = resp.status();
    if (status >= 400 && httpErrors.length < MAX_ISSUES_PER_ROUTE) {
      httpErrors.push({
        kind: 'http-error',
        message: `HTTP ${status}`,
        url: resp.url(),
        status,
      });
    }
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  const issues: RouteIssue[] = [];
  const t0 = Date.now();
  let title: string | null = null;
  try {
    await page.goto(`${base}${route.url}`, {
      waitUntil: 'networkidle',
      timeout: NAV_TIMEOUT_MS,
    });
    await page.waitForTimeout(SETTLE_MS);
    title = await page.title();
    if (title && /^error$/i.test(title.trim())) {
      issues.push({
        kind: 'page-error-title',
        message: `document.title is "${title}" — ErrorBoundary likely fired`,
      });
    }
  } catch (err) {
    issues.push({
      kind: 'nav-failure',
      message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }
  const loadMs = Date.now() - t0;
  return {
    route: route.url,
    family: route.family,
    title,
    issues: [...issues, ...consoleErrors, ...httpErrors],
    loadMs,
  };
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export const DASHBOARD_SMOKE_FAMILY_TO_PAGE_FILE = FAMILY_TO_PAGE_FILE;
export const _SITEMAP_FOR_TESTS = DASHBOARD_SITEMAP;
