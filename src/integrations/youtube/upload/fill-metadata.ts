/**
 * Title / description / made-for-kids fillers for the details step.
 *
 * All paths go through human.ts helpers — jittered typing, trusted
 * mouse clicks — so the timing fingerprint doesn't look like a bot.
 * Studio rate-limited the channel on 2026-04-17 after a few runs of
 * the old one-shot execCommand path; the replacement types char-by-
 * char via Input.insertText and clicks radios via
 * Input.dispatchMouseEvent at the element's center.
 *
 * Made-for-kids: there are two Polymer paper-radios grouped under a
 * `name` attribute. We click the one named VIDEO_MADE_FOR_KIDS_NOT_MFK,
 * falling back to text match if Google ever renames the constant.
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTUploadError } from '../errors.js';
import { SEL } from '../selectors.js';
import { waitForSelector } from '../wait.js';
import { humanClickAt, humanType, sleepRandom } from './human.js';

async function focusAndClear(page: RawCdpPage, selector: string): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const textbox = document.querySelector(${JSON.stringify(selector)});
    if (!textbox || !(textbox instanceof HTMLElement)) return false;
    textbox.focus();
    document.execCommand('selectAll');
    // Delete selection via execCommand 'delete' — this fires the input
    // events Studio expects. One-shot here is fine; no rate-limit risk
    // on a clear action that's indistinguishable from a user select-all + Backspace.
    document.execCommand('delete');
    return true;
  })()`);
}

export async function fillTitle(page: RawCdpPage, title: string): Promise<void> {
  await waitForSelector(page, SEL.META_TITLE_BOX, { timeoutMs: 10_000, label: 'title box' });

  if (!(await focusAndClear(page, SEL.META_TITLE_BOX))) {
    throw new YTUploadError('fill_title', 'title textbox not reachable');
  }
  // Small "aim" pause before typing — a human who just clicked into
  // the title field doesn't start typing on frame 0.
  await sleepRandom(150, 400);
  await humanType(page, title);

  // Verify the write landed and wasn't clobbered by Studio's async
  // filename-autofill. On race, re-clear + re-type (still human-paced).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleepRandom(350, 650);
    const current = await page.evaluate<string>(
      `(() => (document.querySelector(${JSON.stringify(SEL.META_TITLE_BOX)})?.textContent || ''))()`,
    );
    if (current.trim() === title.trim()) return;
    await focusAndClear(page, SEL.META_TITLE_BOX);
    await sleepRandom(120, 300);
    await humanType(page, title);
  }
}

export async function fillDescription(page: RawCdpPage, description: string): Promise<void> {
  if (!description) return;
  const present = await page.evaluate<boolean>(
    `(() => !!document.querySelector(${JSON.stringify(SEL.META_DESCRIPTION_BOX)}))()`,
  );
  if (!present) return;

  if (!(await focusAndClear(page, SEL.META_DESCRIPTION_BOX))) return;
  await sleepRandom(200, 500);
  // Description is much longer than title — bump the per-char upper
  // bound so the total time lands in a realistic range for a person
  // pasting + reviewing a block of copy.
  await humanType(page, description, { perCharMinMs: 25, perCharMaxMs: 90, thinkChance: 0.04 });
}

export async function setNotMadeForKids(page: RawCdpPage): Promise<void> {
  // Resolve the target radio's click coords via evaluate, then
  // humanClickAt. Fall back to click-via-JS only if we can't find a
  // visible candidate (shouldn't happen, but failing closed on
  // coord-resolution beats silently clicking the wrong radio).
  const coords = await page.evaluate<{ x: number; y: number; by: string } | null>(`(() => {
    const radios = Array.from(document.querySelectorAll(${JSON.stringify(SEL.META_KIDS_RADIOS)}));
    const pick = (r) => {
      if (r.offsetParent === null) return null;
      const rect = r.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    for (const r of radios) {
      if (r.getAttribute('name') === 'VIDEO_MADE_FOR_KIDS_NOT_MFK') {
        const c = pick(r); if (c) return { ...c, by: 'name' };
      }
    }
    for (const r of radios) {
      if (/not made for kids/i.test(r.textContent || '')) {
        const c = pick(r); if (c) return { ...c, by: 'text' };
      }
    }
    return null;
  })()`);
  if (!coords) {
    throw new YTUploadError('set_not_for_kids', '"Not made for kids" radio not found');
  }
  await humanClickAt(page, coords.x, coords.y);
}
