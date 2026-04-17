/**
 * Visibility selection + video URL extraction on the final step.
 *
 * Studio's visibility step is a tp-yt-paper-radio-group with three
 * radios named PRIVATE / UNLISTED / PUBLIC. The sidebar of the same
 * dialog surfaces the would-be video URL (a Shorts link for 9:16
 * uploads, a regular /watch link otherwise) which we extract BEFORE
 * clicking Save so we can record it even if the publish click fails.
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTUploadError } from '../errors.js';
import { SEL } from '../selectors.js';
import { humanClickAt, sleepRandom } from './human.js';

export type Visibility = 'private' | 'unlisted' | 'public';

const NAME_MAP: Record<Visibility, string> = {
  private: 'PRIVATE',
  unlisted: 'UNLISTED',
  public: 'PUBLIC',
};

export async function selectVisibility(page: RawCdpPage, visibility: Visibility): Promise<void> {
  const radioName = NAME_MAP[visibility];
  const coords = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const radios = document.querySelectorAll(${JSON.stringify(SEL.VISIBILITY_RADIOS)});
    for (const r of radios) {
      if (r.getAttribute('name') === ${JSON.stringify(radioName)}) {
        if (r.offsetParent === null) continue;
        const rect = r.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    return null;
  })()`);
  if (!coords) throw new YTUploadError('select_visibility', `visibility radio '${radioName}' not found`);
  await humanClickAt(page, coords.x, coords.y);
}

export async function extractVideoUrl(page: RawCdpPage): Promise<string | null> {
  return page.evaluate<string | null>(`(() => {
    const shortsLinks = document.querySelectorAll(${JSON.stringify(SEL.SHORTS_LINK)});
    for (const l of shortsLinks) { if (l instanceof HTMLAnchorElement) return l.href; }
    const links = document.querySelectorAll(${JSON.stringify(SEL.WATCH_LINK)});
    for (const l of links) { if (l instanceof HTMLAnchorElement) return l.href; }
    const allText = document.querySelector(${JSON.stringify(SEL.UPLOAD_DIALOG)})?.textContent || '';
    const m = allText.match(/https:\\/\\/(?:www\\.)?youtube\\.com\\/shorts\\/([\\w-]+)/);
    if (m) return m[0];
    const m2 = allText.match(/https:\\/\\/youtu\\.be\\/([\\w-]+)/);
    if (m2) return m2[0];
    return null;
  })()`);
}

/**
 * Click the Save/Publish button on the final step.
 * Trusted mouse click + short "am I sure?" pause beforehand — Studio's
 * publish step is the most adversarially watched part of the flow.
 */
export async function clickSave(page: RawCdpPage): Promise<void> {
  const coords = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const btns = document.querySelectorAll(${JSON.stringify(SEL.WIZARD_DONE_BUTTON)});
    for (const b of btns) {
      if (b.offsetParent === null) continue;
      if (b.hasAttribute('disabled')) continue;
      const inner = b.querySelector('button');
      const target = (inner && !inner.disabled) ? inner : b;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return null;
  })()`);
  if (!coords) throw new YTUploadError('click_save', 'Save/Publish button not clickable');
  // Final "is this really what I want to post" pause.
  await sleepRandom(800, 2_000);
  await humanClickAt(page, coords.x, coords.y);
}

/**
 * After publish, Studio mounts a "Video processing" dialog with a
 * Close button. Best-effort dismissal — returns true if we found and
 * clicked a close control, false if no dialog was present.
 */
export async function dismissProcessingDialog(page: RawCdpPage): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const closeBtn = document.querySelector(${JSON.stringify(SEL.DIALOG_PROCESSING_CLOSE)});
    if (closeBtn instanceof HTMLElement) { closeBtn.click(); return true; }
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      if ((b.textContent || '').trim() === 'Close' && b.offsetParent !== null) {
        b.click();
        return true;
      }
    }
    return false;
  })()`);
}
