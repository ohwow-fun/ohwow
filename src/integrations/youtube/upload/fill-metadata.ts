/**
 * Title / description / made-for-kids fillers for the details step.
 *
 * Studio's title + description are contenteditable divs (not inputs),
 * so we use `document.execCommand('insertText', …)` — same approach
 * the original _yt-browser.mjs uses, which matches how the React-ish
 * Polymer component processes input events (plain value assignment
 * doesn't fire the needed handlers).
 *
 * Made-for-kids: there are two Polymer paper-radios grouped under a
 * `name` attribute. We click the one named VIDEO_MADE_FOR_KIDS_NOT_MFK,
 * falling back to text match if Google ever renames the constant.
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTUploadError } from '../errors.js';
import { SEL } from '../selectors.js';
import { waitForSelector } from '../wait.js';

export async function fillTitle(page: RawCdpPage, title: string): Promise<void> {
  await waitForSelector(page, SEL.META_TITLE_BOX, { timeoutMs: 10_000, label: 'title box' });
  const ok = await page.evaluate<boolean>(`(() => {
    const textbox = document.querySelector(${JSON.stringify(SEL.META_TITLE_BOX)});
    if (!textbox || !(textbox instanceof HTMLElement)) return false;
    textbox.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, ${JSON.stringify(title)});
    return true;
  })()`);
  if (!ok) throw new YTUploadError('fill_title', 'title textbox not reachable');

  // Verify the write landed and didn't get clobbered by Studio's async
  // filename-autofill. Studio's autofill fires on a variable delay after
  // the title box mounts; if we see a mismatch, re-write. Three attempts
  // is empirically enough — the race window closes after ~1s.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((r) => setTimeout(r, 400));
    const current = await page.evaluate<string>(
      `(() => (document.querySelector(${JSON.stringify(SEL.META_TITLE_BOX)})?.textContent || ''))()`,
    );
    if (current.trim() === title.trim()) return;
    await page.evaluate<boolean>(`(() => {
      const textbox = document.querySelector(${JSON.stringify(SEL.META_TITLE_BOX)});
      if (!textbox || !(textbox instanceof HTMLElement)) return false;
      textbox.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, ${JSON.stringify(title)});
      return true;
    })()`);
  }
}

export async function fillDescription(page: RawCdpPage, description: string): Promise<void> {
  if (!description) return;
  // Description mounts with title — don't fail the whole flow if missing.
  const present = await page.evaluate<boolean>(
    `(() => !!document.querySelector(${JSON.stringify(SEL.META_DESCRIPTION_BOX)}))()`,
  );
  if (!present) return;
  await page.evaluate<boolean>(`(() => {
    const textbox = document.querySelector(${JSON.stringify(SEL.META_DESCRIPTION_BOX)});
    if (!textbox || !(textbox instanceof HTMLElement)) return false;
    textbox.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, ${JSON.stringify(description)});
    return true;
  })()`);
}

export async function setNotMadeForKids(page: RawCdpPage): Promise<void> {
  const clicked = await page.evaluate<string>(`(() => {
    const radios = document.querySelectorAll(${JSON.stringify(SEL.META_KIDS_RADIOS)});
    // Prefer name-based match — Studio's internal enum.
    for (const r of radios) {
      if (r.getAttribute('name') === 'VIDEO_MADE_FOR_KIDS_NOT_MFK') {
        if (r instanceof HTMLElement) { r.click(); return 'by-name'; }
      }
    }
    // Fallback text match.
    for (const r of radios) {
      if (/not made for kids/i.test(r.textContent || '')) {
        if (r instanceof HTMLElement) { r.click(); return 'by-text'; }
      }
    }
    return 'none';
  })()`);
  if (clicked === 'none') {
    throw new YTUploadError('set_not_for_kids', '"Not made for kids" radio not found');
  }
}
