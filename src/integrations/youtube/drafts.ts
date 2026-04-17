/**
 * Operations on an existing Studio draft (created earlier via the
 * upload wizard's stage-as-draft mode).
 *
 * Why this exists: uploadShort({ dryRun: true }) walks the full wizard
 * and leaves the resulting draft in Content → Drafts. Operators need
 * two follow-up actions:
 *   - publishDraft: re-open the wizard at the saved draft, optionally
 *     swap the thumbnail, advance to Visibility, click Save. No re-upload
 *     of the 15MB+ video file.
 *   - deleteDraft: remove the draft from the channel (the edit page's
 *     overflow menu → Delete → confirm flow).
 *
 * Both helpers are CDP-only; no Data API v3 involved. The draft's
 * videoId comes from the prior uploadShort result or the Studio row.
 *
 * Navigation shortcuts used here (empirical, verified 2026-04):
 *   - /channel/{channelId}/videos/upload?d=ud&udvid={videoId}
 *       → re-opens the upload wizard on the matching draft at the
 *         Details step. All wizard selectors work unchanged.
 *   - /video/{videoId}/edit
 *       → per-video edit page. Hosts the top-right #overflow-menu-button
 *         which surfaces Download / Delete / Promote items.
 */

import type { RawCdpPage } from '../../execution/browser/raw-cdp.js';
import { logger } from '../../lib/logger.js';
import { YTUploadError } from './errors.js';
import { SEL } from './selectors.js';
import { waitForSelector } from './wait.js';
import { uploadThumbnail } from './upload/thumbnail.js';
import { clickSave, extractVideoUrl, selectVisibility, type Visibility } from './upload/visibility.js';
import { advanceToStep } from './upload/wizard.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function resumeWizardUrl(channelId: string, videoId: string): string {
  return `https://studio.youtube.com/channel/${channelId}/videos/upload?d=ud&udvid=${videoId}`;
}

function editPageUrl(videoId: string): string {
  return `https://studio.youtube.com/video/${videoId}/edit`;
}

export interface PublishDraftOptions {
  videoId: string;
  channelId: string;
  visibility: Visibility;
  /** Attach/replace the thumbnail on the Details step before advancing. */
  thumbnailPath?: string;
  /** Visibility step index in the wizard. Default 3. */
  visibilityStepIndex?: number;
}

export interface PublishDraftResult {
  videoId: string;
  videoUrl: string | null;
  visibility: Visibility;
}

export async function publishDraft(
  page: RawCdpPage,
  opts: PublishDraftOptions,
): Promise<PublishDraftResult> {
  const stepIndex = opts.visibilityStepIndex ?? 3;

  logger.debug({ videoId: opts.videoId }, '[youtube/drafts] reopening wizard on draft');
  await page.goto(resumeWizardUrl(opts.channelId, opts.videoId));

  // Wait for the Details step to remount.
  await waitForSelector(page, '#title-textarea #textbox', {
    timeoutMs: 12_000,
    label: 'draft details step',
  });

  if (opts.thumbnailPath) {
    await uploadThumbnail(page, opts.thumbnailPath);
  }

  // Give Studio a moment to flush any pending autosave.
  await sleep(400);

  const finalStep = await advanceToStep(page, stepIndex);
  logger.debug({ finalStep }, '[youtube/drafts] reached visibility step');

  await selectVisibility(page, opts.visibility);
  const videoUrl = await extractVideoUrl(page);

  await clickSave(page);
  // Studio shows a processing-confirmation dialog on a brief delay.
  await sleep(1_500);

  return { videoId: opts.videoId, videoUrl, visibility: opts.visibility };
}

/**
 * After a stage-as-draft upload, the wizard's sidebar "wouldBeUrl" is
 * a placeholder that does NOT match the actual saved draft's id. The
 * Content page's row HTML is the source of truth.
 *
 * Two extraction paths, tried in order:
 *   1. Thumbnail URL in the row HTML: i{N}.ytimg.com/vi/{ID}/… — YouTube
 *      serves thumbs from numbered subdomains (i.ytimg.com, i1, i9 …).
 *      This is the fastest path but the thumbnail URL lands on a
 *      variable delay for brand-new drafts.
 *   2. Click the row title (role="button"), wait for Studio to redirect
 *      to /videos/upload?…&udvid={ID}, read the id from the URL bar.
 *      Works for drafts that don't yet have a thumbnail rendered.
 *
 * Returns the newest draft whose title contains `titleContains`
 * (case-insensitive), or null if no match.
 */
export async function findDraftIdByTitle(
  page: RawCdpPage,
  opts: { channelId: string; titleContains: string; timeoutMs?: number },
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const deadline = Date.now() + timeoutMs;

  await page.goto(`https://studio.youtube.com/channel/${opts.channelId}/videos/upload`);
  await sleep(2_500);

  while (Date.now() < deadline) {
    // Path 1: scan row HTML for a thumbnail URL.
    const fromThumbnail = await page.evaluate<string | null>(`(() => {
      const needle = ${JSON.stringify(opts.titleContains.toLowerCase())};
      const rows = Array.from(document.querySelectorAll('ytcp-video-row'));
      for (const row of rows) {
        const t = (row.querySelector('#video-title')?.textContent || '').trim().toLowerCase();
        if (!t.includes(needle)) continue;
        const html = row.outerHTML;
        const m = html.match(/i\\d*\\.ytimg\\.com\\/vi\\/([\\w-]{11})\\//);
        if (m) return m[1];
      }
      return null;
    })()`);
    if (fromThumbnail) return fromThumbnail;

    // Path 2: click the first matching row's title, read udvid from URL.
    const clicked = await page.evaluate<boolean>(`(() => {
      const needle = ${JSON.stringify(opts.titleContains.toLowerCase())};
      const rows = Array.from(document.querySelectorAll('ytcp-video-row'));
      for (const row of rows) {
        const titleEl = row.querySelector('#video-title');
        const t = (titleEl?.textContent || '').trim().toLowerCase();
        if (!t.includes(needle)) continue;
        if (titleEl instanceof HTMLElement) { titleEl.click(); return true; }
      }
      return false;
    })()`);
    if (clicked) {
      // Studio updates the URL bar with udvid= after the click.
      for (let i = 0; i < 10; i += 1) {
        await sleep(300);
        const url = await page.url();
        const m = /[?&]udvid=([\w-]{11})(?:&|$)/.exec(url);
        if (m) return m[1];
      }
    }

    await sleep(600);
  }
  return null;
}

export interface DeleteDraftOptions {
  videoId: string;
}

export async function deleteDraft(page: RawCdpPage, opts: DeleteDraftOptions): Promise<void> {
  logger.debug({ videoId: opts.videoId }, '[youtube/drafts] deleting draft');
  await page.goto(editPageUrl(opts.videoId));

  await waitForSelector(page, SEL.VIDEO_OVERFLOW_MENU_BUTTON, {
    timeoutMs: 12_000,
    label: 'edit page overflow menu',
  });
  await sleep(600);

  // Open the overflow menu. Filter to visible in case Studio mounts
  // a hidden placeholder with the same id elsewhere on the page.
  const opened = await page.evaluate<boolean>(`(() => {
    for (const btn of document.querySelectorAll(${JSON.stringify(SEL.VIDEO_OVERFLOW_MENU_BUTTON)})) {
      if (btn.offsetParent !== null && btn instanceof HTMLElement) {
        btn.click(); return true;
      }
    }
    return false;
  })()`);
  if (!opened) {
    throw new YTUploadError('delete_draft', 'overflow menu button not clickable');
  }

  // Poll for the Delete item to appear (the Polymer menu hydrates on
  // a variable delay; fixed sleeps flake). Text-match is stable — id
  // text-item-N is positional and shifts with item reordering.
  const menuDeadline = Date.now() + 4_000;
  let clickedDelete = false;
  while (Date.now() < menuDeadline) {
    clickedDelete = await page.evaluate<boolean>(`(() => {
      const items = document.querySelectorAll(${JSON.stringify(SEL.VIDEO_OVERFLOW_MENU_ITEMS)});
      for (const item of items) {
        if (item.offsetParent === null) continue;
        if (/^delete$/i.test((item.textContent || '').trim())) {
          if (item instanceof HTMLElement) { item.click(); return true; }
        }
      }
      return false;
    })()`);
    if (clickedDelete) break;
    await sleep(200);
  }
  if (!clickedDelete) {
    throw new YTUploadError('delete_draft', 'Delete menu item never mounted or not visible');
  }

  // Poll for the confirmation dialog to mount. Fixed sleeps flake
  // here — the dialog appears 800-1500ms after the menu click on a
  // healthy connection, sometimes longer.
  const dialogDeadline = Date.now() + 4_000;
  let dialogMounted = false;
  while (Date.now() < dialogDeadline) {
    dialogMounted = await page.evaluate<boolean>(
      `!!document.querySelector('ytcp-confirmation-dialog, tp-yt-paper-dialog[opened]')`,
    );
    if (dialogMounted) break;
    await sleep(200);
  }
  if (!dialogMounted) {
    throw new YTUploadError('delete_draft', 'confirmation dialog never mounted');
  }

  // Check the acknowledgement checkbox. Only click if not already
  // checked — a double-click toggles it back off.
  await page.evaluate<boolean>(`(() => {
    const cb = document.querySelector('ytcp-checkbox-lit#confirm-checkbox');
    if (!cb) return false;
    const isChecked = cb.hasAttribute('checked') || cb.getAttribute('aria-checked') === 'true';
    if (!isChecked && cb instanceof HTMLElement) { cb.click(); return true; }
    return false;
  })()`);

  // Wait up to 3s for the confirm button to become enabled (Studio
  // gates it behind the checkbox). We explicitly scope to the dialog
  // and match by text so the page-level "Save" / other "Confirm"
  // buttons don't get picked.
  const deadline = Date.now() + 3_000;
  let confirmed = false;
  while (Date.now() < deadline) {
    confirmed = await page.evaluate<boolean>(`(() => {
      const dlg = document.querySelector('ytcp-confirmation-dialog, tp-yt-paper-dialog[opened]');
      if (!dlg) return false;
      const btns = dlg.querySelectorAll('ytcp-button');
      for (const b of btns) {
        if (b.offsetParent === null) continue;
        if (b.hasAttribute('disabled')) continue;
        const label = (b.getAttribute('label') || b.textContent || '').trim();
        // Match both draft-delete ("Delete draft video") and
        // published-delete ("Delete forever") phrasings. Avoid Cancel.
        if (/delete/i.test(label) && !/cancel/i.test(label)) {
          const inner = b.querySelector('button');
          if (inner && !inner.disabled) { inner.click(); return true; }
          if (b instanceof HTMLElement) { b.click(); return true; }
        }
      }
      return false;
    })()`);
    if (confirmed) break;
    await sleep(200);
  }
  if (!confirmed) {
    throw new YTUploadError('delete_draft', 'delete confirmation button never enabled / not found');
  }

  // Studio's delete is server-round-trip — poll the edit page for an
  // error state or the overflow button to vanish as the positive
  // signal, with a 5s floor so the server has real time to commit.
  await sleep(3_000);
  const deadlineVerify = Date.now() + 5_000;
  let gone = false;
  while (Date.now() < deadlineVerify) {
    gone = await page.evaluate<boolean>(
      `!document.querySelector('ytcp-confirmation-dialog[opened], tp-yt-paper-dialog[opened]')`,
    );
    if (gone) break;
    await sleep(300);
  }
  logger.debug({ videoId: opts.videoId, gone }, '[youtube/drafts] delete completed');
}
