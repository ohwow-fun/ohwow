/**
 * List videos on the logged-in channel.
 *
 * Studio's Content page (studio.youtube.com/channel/{id}/videos/upload)
 * lists videos in rows with per-video ids on the containing element.
 * On empty channels the page instead mounts ytcp-warm-welcome — we
 * detect that and return isEmpty:true without raising.
 *
 * We deliberately DO NOT scroll-paginate — that turns a cheap read
 * into an unbounded crawl. Callers bound by `limit` (default 50).
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTReadError } from '../errors.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface VideoListEntry {
  videoId: string;
  title: string | null;
  visibility: string | null;
  views: string | null;
  publishedAt: string | null;
}

export interface VideoListResult {
  channelId: string;
  videos: VideoListEntry[];
  isEmpty: boolean;
  scrapedFrom: string;
}

export interface ListVideosOptions {
  limit?: number;
}

export async function listMyVideos(
  page: RawCdpPage,
  channelId: string,
  opts: ListVideosOptions = {},
): Promise<VideoListResult> {
  const limit = opts.limit ?? 50;
  const url = `https://studio.youtube.com/channel/${channelId}/videos/upload`;
  await page.goto(url);

  // Wait for either the warm-welcome (empty channel) or video rows.
  const deadline = Date.now() + 12_000;
  let state: 'empty' | 'populated' | 'error' | 'loading' = 'loading';
  while (Date.now() < deadline) {
    state = await page.evaluate<'empty' | 'populated' | 'error' | 'loading'>(`(() => {
      if (document.querySelector('ytcp-warm-welcome')) return 'empty';
      if (document.querySelectorAll('[video-id], ytcp-video-row').length > 0) return 'populated';
      const err = document.querySelector('ytcp-error-section');
      if (err && (err.textContent || '').includes('something went wrong')) return 'error';
      return 'loading';
    })()`);
    if (state !== 'loading') break;
    await sleep(250);
  }

  if (state === 'error') {
    throw new YTReadError('list_videos', 'Studio content list failed to load ("Oops, something went wrong"). Retry.');
  }
  if (state === 'empty') {
    return { channelId, videos: [], isEmpty: true, scrapedFrom: url };
  }
  if (state === 'loading') {
    throw new YTReadError('list_videos', `video list did not mount within 12s at ${url}`);
  }

  const rows = await page.evaluate<VideoListEntry[]>(`(() => {
    const rows = document.querySelectorAll('[video-id], ytcp-video-row');
    const out = [];
    for (let i = 0; i < rows.length && i < ${limit}; i++) {
      const el = rows[i];
      const videoId = el.getAttribute('video-id') || el.dataset?.videoId || '';
      if (!videoId) continue;
      const title = el.querySelector('#video-title, .video-title, [aria-label*="title"]')?.textContent?.trim() || null;
      const visibility = el.querySelector('.visibility, [aria-label*="Visibility" i]')?.textContent?.trim() || null;
      const views = el.querySelector('[column-id="views"], .views')?.textContent?.trim() || null;
      const publishedAt = el.querySelector('[column-id="date"], .date, .published')?.textContent?.trim() || null;
      out.push({ videoId, title, visibility, views, publishedAt });
    }
    return out;
  })()`);

  return { channelId, videos: rows, isEmpty: rows.length === 0, scrapedFrom: url };
}
