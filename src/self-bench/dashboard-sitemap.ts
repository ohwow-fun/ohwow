/**
 * Canonical list of dashboard routes self-bench experiments visit.
 *
 * The runtime's Express server mounts the Vite SPA at /ui, so every
 * SPA route needs that prefix. /login and /onboarding live outside
 * RequireAuth; everything else requires a valid bearer token. Detail
 * routes (agents/:id, tasks/:id, etc.) need a fixture id to resolve
 * meaningfully — marked with requiresSeed so smoke experiments can
 * skip them until the fixture loader lands.
 *
 * Kept as a hand-committed list (source of truth) paired with
 * SitemapDriftExperiment which parses App.tsx and fires a finding
 * when the two drift. Hand editing + drift check is simpler and more
 * auditable than deriving the sitemap at runtime.
 */

export type SitemapCategory = 'public' | 'authed' | 'detail' | 'redirect';

export interface SitemapEntry {
  /** Relative path as it appears in App.tsx. */
  reactRoute: string;
  /** Full path to navigate to, including /ui prefix where applicable. */
  url: string;
  category: SitemapCategory;
  /** True when the route needs a seeded fixture id (e.g. :id segments). */
  requiresSeed: boolean;
  /**
   * Human tag for the route family. Used by smoke experiments to
   * group findings ('agents', 'tasks', …) without parsing the URL.
   */
  family: string;
}

const UI = '/ui';

/**
 * Canonical sitemap. Ordering mirrors App.tsx for easy diffing.
 * Update this file when App.tsx gains or loses a route; the drift
 * experiment will remind you if you forget.
 */
export const DASHBOARD_SITEMAP: readonly SitemapEntry[] = [
  // /login and /onboarding are declared at the top level inside the
  // React Router tree, but the Express server mounts the entire SPA
  // under /ui — so the actual URLs the browser sees include the UI
  // prefix. Early smoke runs with the bare paths returned 404 (the
  // backend has no top-level /login route), which is how this was
  // caught. Keep them tagged category:'public' because they don't
  // require the authed bearer token to render.
  { reactRoute: '/login',                 url: `${UI}/login`,            category: 'public',   requiresSeed: false, family: 'auth' },
  { reactRoute: '/onboarding',            url: `${UI}/onboarding`,       category: 'public',   requiresSeed: false, family: 'onboarding' },
  { reactRoute: 'dashboard',              url: `${UI}/dashboard`,        category: 'authed',   requiresSeed: false, family: 'dashboard' },
  { reactRoute: 'agents',                 url: `${UI}/agents`,           category: 'authed',   requiresSeed: false, family: 'agents' },
  { reactRoute: 'agents/:id',             url: `${UI}/agents/:id`,       category: 'detail',   requiresSeed: true,  family: 'agents' },
  { reactRoute: 'tasks',                  url: `${UI}/tasks`,            category: 'authed',   requiresSeed: false, family: 'tasks' },
  { reactRoute: 'tasks/:id',              url: `${UI}/tasks/:id`,        category: 'detail',   requiresSeed: true,  family: 'tasks' },
  { reactRoute: 'contacts',               url: `${UI}/contacts`,         category: 'authed',   requiresSeed: false, family: 'contacts' },
  { reactRoute: 'contacts/:id',           url: `${UI}/contacts/:id`,     category: 'detail',   requiresSeed: true,  family: 'contacts' },
  { reactRoute: 'projects',               url: `${UI}/projects`,         category: 'authed',   requiresSeed: false, family: 'projects' },
  { reactRoute: 'projects/:id',           url: `${UI}/projects/:id`,     category: 'detail',   requiresSeed: true,  family: 'projects' },
  { reactRoute: 'templates',              url: `${UI}/templates`,        category: 'authed',   requiresSeed: false, family: 'templates' },
  { reactRoute: 'automations',            url: `${UI}/automations`,      category: 'authed',   requiresSeed: false, family: 'automations' },
  { reactRoute: 'automations/new',        url: `${UI}/automations/new`,  category: 'authed',   requiresSeed: false, family: 'automations' },
  { reactRoute: 'automations/:id/edit',   url: `${UI}/automations/:id/edit`, category: 'detail', requiresSeed: true, family: 'automations' },
  { reactRoute: 'connections',            url: `${UI}/connections`,      category: 'authed',   requiresSeed: false, family: 'connections' },
  { reactRoute: 'approvals',              url: `${UI}/approvals`,        category: 'authed',   requiresSeed: false, family: 'approvals' },
  { reactRoute: 'activity',               url: `${UI}/activity`,         category: 'authed',   requiresSeed: false, family: 'activity' },
  { reactRoute: 'schedules',              url: `${UI}/schedules`,        category: 'authed',   requiresSeed: false, family: 'schedules' },
  { reactRoute: 'knowledge',              url: `${UI}/knowledge`,        category: 'authed',   requiresSeed: false, family: 'knowledge' },
  { reactRoute: 'messages',               url: `${UI}/messages`,         category: 'authed',   requiresSeed: false, family: 'messages' },
  { reactRoute: 'workflows',              url: `${UI}/workflows`,        category: 'authed',   requiresSeed: false, family: 'workflows' },
  { reactRoute: 'webhook-events',         url: `${UI}/webhook-events`,   category: 'authed',   requiresSeed: false, family: 'webhook-events' },
  { reactRoute: 'goals',                  url: `${UI}/goals`,            category: 'authed',   requiresSeed: false, family: 'goals' },
  { reactRoute: 'revenue',                url: `${UI}/revenue`,          category: 'authed',   requiresSeed: false, family: 'revenue' },
  { reactRoute: 'messaging',              url: `${UI}/messaging`,        category: 'authed',   requiresSeed: false, family: 'messaging' },
  { reactRoute: 'peers',                  url: `${UI}/peers`,            category: 'authed',   requiresSeed: false, family: 'peers' },
  { reactRoute: 'team',                   url: `${UI}/team`,             category: 'authed',   requiresSeed: false, family: 'team' },
  { reactRoute: 'browser',                url: `${UI}/browser`,          category: 'authed',   requiresSeed: false, family: 'browser' },
  { reactRoute: 'briefings',              url: `${UI}/briefings`,        category: 'authed',   requiresSeed: false, family: 'briefings' },
  { reactRoute: 'podcast',                url: `${UI}/podcast`,          category: 'authed',   requiresSeed: false, family: 'podcast' },
  { reactRoute: 'eye',                    url: `${UI}/eye`,              category: 'authed',   requiresSeed: false, family: 'eye' },
  { reactRoute: 'chat',                   url: `${UI}/chat`,             category: 'redirect', requiresSeed: false, family: 'chat' },
  { reactRoute: 'settings',               url: `${UI}/settings`,         category: 'authed',   requiresSeed: false, family: 'settings' },
];

/** Routes safe to visit in a stateless smoke probe. */
export function smokeableRoutes(): SitemapEntry[] {
  return DASHBOARD_SITEMAP.filter(
    (r) => r.category !== 'detail' && r.category !== 'redirect',
  );
}

/** Repo-relative path to App.tsx — the drift experiment's source of truth. */
export const APP_TSX_PATH = 'src/web/src/App.tsx';

/**
 * Parse every <Route path="…"> in App.tsx. Minimal regex — safer than
 * pulling in the full TS parser for a three-argument JSX element, and
 * we only need the path attribute. Returns routes in source order.
 */
export function parseAppTsxRoutes(appTsxSource: string): string[] {
  const re = /<Route\s+(?:[^>]*?\s)?path=(?:"([^"]*)"|'([^']*)')/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(appTsxSource)) !== null) {
    const raw = m[1] ?? m[2] ?? '';
    // App.tsx uses "/*" as the RequireAuth wrapper; not a real
    // visitable route, skip.
    if (raw === '/*') continue;
    out.push(raw);
  }
  return out;
}

/**
 * Diff parsed App.tsx routes against the committed sitemap. Pure
 * function — the experiment wraps it with file I/O. Returns missing
 * (in App, not in sitemap) and stale (in sitemap, not in App).
 */
export function diffSitemap(
  appRoutes: readonly string[],
  sitemap: readonly SitemapEntry[] = DASHBOARD_SITEMAP,
): { missing: string[]; stale: string[] } {
  const inApp = new Set(appRoutes);
  const inSitemap = new Set(sitemap.map((s) => s.reactRoute));
  const missing = [...inApp].filter((r) => !inSitemap.has(r));
  const stale = [...inSitemap].filter((r) => !inApp.has(r));
  return { missing, stale };
}
