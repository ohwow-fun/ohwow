/**
 * Per-video metadata scrape.
 *
 * Navigates to studio.youtube.com/video/{id}/edit and pulls title,
 * description, visibility, processing state, view count, and policy
 * flags from the rendered form. Non-destructive — no inputs are
 * changed, no buttons clicked.
 *
 * We prefer reading from window.ytcfg.data_ first when the Studio app
 * has cached the video payload (mounts a VIDEO object on some flows).
 * DOM is a fallback and handles cases where ytcfg doesn't have it.
 *
 * Untested end-to-end in the current session (channel has no videos
 * yet). Selectors are pinned against the DOM shape documented in
 * _yt-probe-upload.mjs output — update when drift is observed.
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTReadError } from '../errors.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface VideoMetadata {
  videoId: string;
  title: string | null;
  description: string | null;
  visibility: string | null;
  processingStatus: string | null;
  /** Text from the views column ("1.2K views"). Raw string. */
  viewsDisplay: string | null;
  likesDisplay: string | null;
  commentsCountDisplay: string | null;
  /** "https://youtu.be/..." or "https://youtube.com/shorts/..." when available. */
  publicUrl: string | null;
  scrapedFrom: string;
}

export async function videoMetadata(page: RawCdpPage, videoId: string): Promise<VideoMetadata> {
  const url = `https://studio.youtube.com/video/${videoId}/edit`;
  await page.goto(url);

  // Wait for the title box to mount (signals the edit form is ready).
  const deadline = Date.now() + 12_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page.evaluate<boolean>(
      `(() => !!document.querySelector('#title-textarea #textbox, ytcp-video-title'))()`,
    );
    if (ready) break;
    await sleep(250);
  }
  if (!ready) {
    throw new YTReadError('video_metadata', `edit form for video ${videoId} did not mount within 12s`);
  }

  const probe = await page.evaluate<Omit<VideoMetadata, 'videoId' | 'scrapedFrom'> & { url: string }>(`(() => {
    const title = document.querySelector('#title-textarea #textbox')?.textContent?.trim() || null;
    const description = document.querySelector('#description-textarea #textbox')?.textContent?.trim() || null;
    const visibility = (() => {
      const el = document.querySelector('ytcp-video-visibility-select [aria-label], ytcp-video-visibility-select [aria-valuenow]');
      if (!el) return null;
      return el.getAttribute('aria-label') || (el.textContent || '').trim() || null;
    })();
    const processingStatus = (() => {
      const el = document.querySelector('ytcp-video-upload-progress, .ytcp-video-upload-progress, ytcp-video-details-status');
      return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null;
    })();

    // Metric rows — label + display value.
    let viewsDisplay = null, likesDisplay = null, commentsCountDisplay = null;
    const metrics = document.querySelectorAll('ytcp-video-metrics *');
    for (const el of metrics) {
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!viewsDisplay && /^views/i.test(text)) {
        const m = text.match(/views\\s*([0-9][0-9.,KMB]*)/i);
        if (m) viewsDisplay = m[1];
      }
      if (!likesDisplay && /^likes/i.test(text)) {
        const m = text.match(/likes\\s*([0-9][0-9.,KMB]*)/i);
        if (m) likesDisplay = m[1];
      }
      if (!commentsCountDisplay && /^comments/i.test(text)) {
        const m = text.match(/comments\\s*([0-9][0-9.,KMB]*)/i);
        if (m) commentsCountDisplay = m[1];
      }
    }

    // Public URL: the right-side link panel usually shows a /watch or /shorts URL.
    let publicUrl = null;
    const publicLink = document.querySelector('a[href*="youtube.com/watch"], a[href*="youtu.be/"], a[href*="youtube.com/shorts"]');
    if (publicLink instanceof HTMLAnchorElement) publicUrl = publicLink.href;

    return { title, description, visibility, processingStatus, viewsDisplay, likesDisplay, commentsCountDisplay, publicUrl, url: location.href };
  })()`);

  return {
    videoId,
    title: probe.title,
    description: probe.description,
    visibility: probe.visibility,
    processingStatus: probe.processingStatus,
    viewsDisplay: probe.viewsDisplay,
    likesDisplay: probe.likesDisplay,
    commentsCountDisplay: probe.commentsCountDisplay,
    publicUrl: probe.publicUrl,
    scrapedFrom: probe.url,
  };
}
