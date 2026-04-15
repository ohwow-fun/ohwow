import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DASHBOARD_SITEMAP,
  APP_TSX_PATH,
  parseAppTsxRoutes,
  diffSitemap,
  smokeableRoutes,
} from '../dashboard-sitemap.js';

describe('parseAppTsxRoutes', () => {
  it('extracts every <Route path> in source order and skips the /* wrapper', () => {
    const src = `
      <Routes>
        <Route path="/login" element={<X/>} />
        <Route path="/*" element={<Y/>}>
          <Route path="agents" element={<A/>} />
          <Route path='tasks/:id' element={<B/>} />
        </Route>
      </Routes>
    `;
    expect(parseAppTsxRoutes(src)).toEqual(['/login', 'agents', 'tasks/:id']);
  });

  it('returns [] for source with no Route elements', () => {
    expect(parseAppTsxRoutes('<div>hi</div>')).toEqual([]);
  });
});

describe('diffSitemap', () => {
  it('flags App routes missing from sitemap', () => {
    const sitemap = [{ reactRoute: 'agents', url: '/ui/agents', category: 'authed', requiresSeed: false, family: 'agents' }] as const;
    const { missing, stale } = diffSitemap(['agents', 'tasks'], sitemap);
    expect(missing).toEqual(['tasks']);
    expect(stale).toEqual([]);
  });

  it('flags sitemap routes missing from App', () => {
    const sitemap = [
      { reactRoute: 'agents', url: '/ui/agents', category: 'authed', requiresSeed: false, family: 'agents' },
      { reactRoute: 'gone', url: '/ui/gone', category: 'authed', requiresSeed: false, family: 'gone' },
    ] as const;
    const { missing, stale } = diffSitemap(['agents'], sitemap);
    expect(missing).toEqual([]);
    expect(stale).toEqual(['gone']);
  });

  it('returns empty diffs when in sync', () => {
    const sitemap = [{ reactRoute: 'a', url: '/ui/a', category: 'authed', requiresSeed: false, family: 'a' }] as const;
    expect(diffSitemap(['a'], sitemap)).toEqual({ missing: [], stale: [] });
  });
});

describe('DASHBOARD_SITEMAP', () => {
  it('matches the live App.tsx (integration: reads the real file)', () => {
    const appPath = path.resolve(__dirname, '../../../', APP_TSX_PATH);
    const src = fs.readFileSync(appPath, 'utf-8');
    const appRoutes = parseAppTsxRoutes(src);
    const { missing, stale } = diffSitemap(appRoutes, DASHBOARD_SITEMAP);
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it('smokeableRoutes excludes detail and redirect entries', () => {
    const smokeable = smokeableRoutes();
    expect(smokeable.every((r) => r.category !== 'detail' && r.category !== 'redirect')).toBe(true);
    expect(smokeable.length).toBeLessThan(DASHBOARD_SITEMAP.length);
    expect(smokeable.length).toBeGreaterThan(10);
  });
});
