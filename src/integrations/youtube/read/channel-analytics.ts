/**
 * Channel-level analytics + dashboard summary scraper.
 *
 * Studio's dashboard (studio.youtube.com/channel/{id}) surfaces
 * subscriber count, a "Summary" card with last-28d metrics, and a
 * "Latest video performance" card. We read the dashboard because it
 * renders sanely even for empty channels (we tested against one with
 * zero videos and the subscriber card still mounts).
 *
 * For deeper time-series we navigate to the Analytics page
 * (/analytics/tab-overview/period-<window>) which loads a grid of
 * metric cards. The metric labels + values are read from DOM text
 * rather than private GraphQL — slower but more stable across
 * Studio rewrites.
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { logger } from '../../../lib/logger.js';
import { YTReadError } from '../errors.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ChannelSummary {
  channelId: string;
  /** Display name shown in the dashboard header. */
  channelName: string | null;
  /** Number as reported by Studio (may be "1.2K" — we surface raw string + parsed). */
  subscribersDisplay: string | null;
  subscribersParsed: number | null;
  /** True when Studio shows the "upload your first video" warm welcome. */
  isEmptyChannel: boolean;
  /** URL scraped from (for debugging). */
  scrapedFrom: string;
}

/** Parse Studio's abbreviated counts ("1.2K", "3.4M", "123"). */
export function parseAbbrevCount(s: string | null): number | null {
  if (!s) return null;
  const t = s.trim().replace(/,/g, '');
  const m = t.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMB])?$/i);
  if (!m) {
    const n = Number.parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
  }
  const num = Number.parseFloat(m[1]);
  const mult = m[2] ? { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[m[2].toLowerCase() as 'k' | 'm' | 'b'] : 1;
  return Math.round(num * mult);
}

/**
 * Navigate to the channel dashboard and read the top-level summary.
 * Does not read full analytics time-series — use analyticsOverview()
 * for that. Safe on empty channels (returns subscribersParsed=0 and
 * isEmptyChannel=true).
 */
export async function channelSummary(page: RawCdpPage, channelId: string): Promise<ChannelSummary> {
  const url = `https://studio.youtube.com/channel/${channelId}`;
  await page.goto(url);

  // Dashboard takes a beat to mount the cards; poll for either the
  // channel-name header, the warm-welcome, or the "Current subscribers"
  // body text — whichever lands first. Then give the rest of the page
  // 1s grace to finish painting.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate<boolean>(`(() => {
      if (document.querySelector('ytcp-warm-welcome, ytcp-sidenav-header')) return true;
      const t = (document.body ? document.body.textContent : '') || '';
      return /Current subscribers/.test(t);
    })()`);
    if (ready) break;
    await sleep(200);
  }
  await sleep(1_000);

  const probe = await page.evaluate<{ channelName: string | null; subsDisplay: string | null; isEmpty: boolean; url: string; _err?: string }>(`(() => {
    try {
      // Channel name: the nav drawer shows "Your channel" immediately
      // followed by the channel name. Regex from body text is more
      // reliable than any single selector since Studio reshuffles
      // nav-header internals regularly.
      let channelName = null;
      const bodyText = (document.body ? document.body.textContent : '') || '';
      const normalized = bodyText.replace(/\\s+/g, ' ');
      const nameMatch = normalized.match(/Your channel\\s+([A-Za-z0-9_.\\-@][^\\n]*?)\\s+(?:Dashboard|Content|Analytics)/);
      if (nameMatch) channelName = nameMatch[1].trim().slice(0, 80);

      let subsDisplay = null;
      const cards = document.querySelectorAll('ytcp-card, ytcp-metric-card, .ytcp-card');
      for (const c of cards) {
        const t = (c.textContent || '').replace(/\\s+/g, ' ').trim();
        const m = t.match(/Current subscribers[^0-9]*([0-9][0-9.,KMB]*)/i);
        if (m) { subsDisplay = m[1]; break; }
      }
      if (!subsDisplay) {
        const m2 = normalized.match(/Current subscribers\\s*([0-9][0-9.,KMB]*)/i);
        if (m2) subsDisplay = m2[1];
      }

      const isEmpty = !!document.querySelector('ytcp-warm-welcome');

      return { channelName, subsDisplay, isEmpty, url: location.href };
    } catch (e) {
      return { channelName: null, subsDisplay: null, isEmpty: false, url: location.href, _err: String(e) };
    }
  })()`);

  if (!probe.channelName && !probe.subsDisplay) {
    logger.warn({ url }, '[youtube/read] channelSummary found neither name nor subscribers — DOM may have shifted');
  }

  return {
    channelId,
    channelName: probe.channelName,
    subscribersDisplay: probe.subsDisplay,
    subscribersParsed: parseAbbrevCount(probe.subsDisplay),
    isEmptyChannel: probe.isEmpty,
    scrapedFrom: probe.url,
  };
}

export interface AnalyticsWindow {
  /** 7, 28, 90, 365, or a specific number of days. */
  days: number;
}

export interface AnalyticsMetric {
  label: string;
  /** Raw display string from the card (e.g. "1.2K", "45:12"). */
  display: string;
  /** Numeric parse of `display` when reasonable; null for durations/non-numeric. */
  value: number | null;
}

export interface AnalyticsOverview {
  channelId: string;
  windowDays: number;
  metrics: AnalyticsMetric[];
  /** True when Studio renders an "upload a video to see analytics" placeholder. */
  isEmpty: boolean;
  /** URL the scrape ran against. */
  scrapedFrom: string;
}

/**
 * Load /analytics/tab-overview/period-<days> and collect every metric
 * card on the page. Each card is a { label, display, value } tuple.
 * Call order and selector specificity are deliberately loose — if
 * Studio reshuffles card IDs, we still surface whatever mounted.
 */
export async function analyticsOverview(
  page: RawCdpPage,
  channelId: string,
  windowDays = 28,
): Promise<AnalyticsOverview> {
  const periodToken = windowDaysToPeriodToken(windowDays);
  const url = `https://studio.youtube.com/channel/${channelId}/analytics/tab-overview/period-${periodToken}`;
  await page.goto(url);

  // Wait for any card container to mount.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate<boolean>(
      `(() => document.querySelectorAll('ytcp-analytics-card, ytcp-card, .metric-card').length > 0)()`,
    );
    if (ready) break;
    await sleep(250);
  }

  const probe = await page.evaluate<{ metrics: { label: string; display: string }[]; isEmpty: boolean; hasStudioError: boolean; url: string }>(`(() => {
    try {
      const out = [];
      const cards = document.querySelectorAll('ytcp-analytics-card, ytcp-card, .metric-card, ytcp-animated-score-card');
      for (const c of cards) {
        const label = (c.querySelector('[role="heading"], h1, h2, h3, .title, .metric-title')?.textContent || '').trim();
        const valueEl = c.querySelector('.metric-value, .value, .score, ytcp-animated-value');
        let display = (valueEl?.textContent || '').trim();
        if (!display) {
          const full = (c.textContent || '').replace(/\\s+/g, ' ').trim();
          display = full.replace(label, '').trim();
        }
        if (label && display) out.push({ label, display: display.slice(0, 80) });
      }
      const bodyText = (document.body ? document.body.textContent : '') || '';
      const hasStudioError = /Oops, something went wrong/i.test(bodyText) && !!document.querySelector('ytcp-error-section');
      const isEmpty =
        out.length === 0 &&
        !hasStudioError &&
        (/Upload and publish a video to get started/i.test(bodyText) ||
          /Want to see metrics/i.test(bodyText));
      return { metrics: out, isEmpty, hasStudioError, url: location.href };
    } catch { return { metrics: [], isEmpty: false, hasStudioError: false, url: location.href }; }
  })()`);

  if (probe.hasStudioError) {
    throw new YTReadError(
      'analytics_overview',
      'Studio analytics page rendered the "Oops, something went wrong" error — typically a transient Studio issue on empty channels. Retry later or upload content first.',
      { url: probe.url, windowDays, transient: true },
    );
  }
  if (probe.metrics.length === 0 && !probe.isEmpty) {
    throw new YTReadError(
      'analytics_overview',
      `analytics overview: no metric cards found at ${probe.url} — page may not have loaded or selectors drifted`,
      { url: probe.url, windowDays },
    );
  }

  return {
    channelId,
    windowDays,
    isEmpty: probe.isEmpty,
    scrapedFrom: probe.url,
    metrics: probe.metrics.map((m) => ({
      label: m.label,
      display: m.display,
      value: parseAbbrevCount(m.display),
    })),
  };
}

function windowDaysToPeriodToken(days: number): string {
  // Studio period tokens are free-form strings like "default", "last_7_days",
  // "last_28_days", "last_90_days", "last_365_days". Pick the closest.
  if (days <= 7) return 'last_7_days';
  if (days <= 28) return 'last_28_days';
  if (days <= 90) return 'last_90_days';
  return 'last_365_days';
}
