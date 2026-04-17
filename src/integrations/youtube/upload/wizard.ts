/**
 * Upload wizard step navigation.
 *
 * Studio renders a stepper UI (Details / Video elements / Checks /
 * Visibility) and advances via a #next-button. The button exists
 * twice in the DOM; only the one with `offsetParent !== null` is
 * actionable. Step index is read from the `aria-selected` attr on
 * [id^="step-badge-N"].
 *
 * clickNextAndAwaitStep retries up to 3× when the badge doesn't
 * advance — catches the race where the button is clickable but Studio
 * is still validating the previous step and silently no-ops.
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTUploadError } from '../errors.js';
import { SEL } from '../selectors.js';
import { waitForPredicate } from '../wait.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function getCurrentStepIndex(page: RawCdpPage): Promise<number> {
  return page.evaluate<number>(`(() => {
    const badges = document.querySelectorAll(${JSON.stringify(SEL.WIZARD_STEP_BADGES)});
    for (const b of badges) {
      if (b.getAttribute('aria-selected') === 'true') {
        const id = b.id || '';
        const m = id.match(/step-badge-(\\d+)/);
        if (m) return parseInt(m[1], 10);
      }
    }
    return -1;
  })()`);
}

async function clickVisibleNext(page: RawCdpPage): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const btns = document.querySelectorAll(${JSON.stringify(SEL.WIZARD_NEXT_BUTTON)});
    for (const b of btns) {
      if (b.offsetParent !== null && !b.hasAttribute('disabled')) {
        const inner = b.querySelector('button');
        if (inner && !inner.disabled) { inner.click(); return true; }
        if (b instanceof HTMLElement) { b.click(); return true; }
      }
    }
    return false;
  })()`);
}

/**
 * Click Next and verify the step badge advanced past `currentStep`.
 * Retries up to 3× with 500ms backoff between attempts.
 */
export async function clickNextAndAwaitAdvance(page: RawCdpPage, currentStep: number, maxAttempts = 3): Promise<number> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const clicked = await clickVisibleNext(page);
    if (!clicked && attempt === maxAttempts) {
      throw new YTUploadError('step_advance', `Next button not clickable on step ${currentStep}`);
    }
    if (!clicked) { await sleep(500); continue; }
    try {
      await waitForPredicate(
        page,
        `(() => {
          const badges = document.querySelectorAll(${JSON.stringify(SEL.WIZARD_STEP_BADGES)});
          for (const b of badges) {
            if (b.getAttribute('aria-selected') === 'true') {
              const id = b.id || '';
              const m = id.match(/step-badge-(\\d+)/);
              if (m && parseInt(m[1], 10) > ${currentStep}) return true;
            }
          }
          return false;
        })()`,
        { timeoutMs: 5_000, label: `step advance past ${currentStep}` },
      );
      return getCurrentStepIndex(page);
    } catch {
      if (attempt < maxAttempts) await sleep(500 * attempt);
    }
  }
  throw new YTUploadError('step_advance', `step never advanced past ${currentStep} after ${maxAttempts} attempts`);
}

/**
 * Walk from the current step up to (and including) `targetStep` by
 * clicking Next. Returns the final step index.
 */
export async function advanceToStep(page: RawCdpPage, targetStep: number): Promise<number> {
  let step = await getCurrentStepIndex(page);
  if (step < 0) throw new YTUploadError('step_advance', 'wizard step badges not mounted');
  let guard = 0;
  while (step < targetStep) {
    step = await clickNextAndAwaitAdvance(page, step);
    if (++guard > 6) throw new YTUploadError('step_advance', `safety guard: too many advances trying to reach step ${targetStep}`);
  }
  return step;
}
