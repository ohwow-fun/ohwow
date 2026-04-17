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
import { humanClickAt, sleepRandom } from './human.js';

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

async function nextButtonCoords(page: RawCdpPage): Promise<{ x: number; y: number } | null> {
  return page.evaluate<{ x: number; y: number } | null>(`(() => {
    const btns = document.querySelectorAll(${JSON.stringify(SEL.WIZARD_NEXT_BUTTON)});
    for (const b of btns) {
      if (b.offsetParent === null) continue;
      if (b.hasAttribute('disabled')) continue;
      const inner = b.querySelector('button');
      const target = (inner && !inner.disabled) ? inner : b;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  })()`);
}

/**
 * Click Next (via a trusted mouse event) and verify the step badge
 * advanced past `currentStep`. Retries up to 3× with jittered backoff.
 */
export async function clickNextAndAwaitAdvance(page: RawCdpPage, currentStep: number, maxAttempts = 3): Promise<number> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const coords = await nextButtonCoords(page);
    if (!coords) {
      if (attempt === maxAttempts) {
        throw new YTUploadError('step_advance', `Next button not clickable on step ${currentStep}`);
      }
      await sleepRandom(600, 1_100);
      continue;
    }
    await humanClickAt(page, coords.x, coords.y);
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
      if (attempt < maxAttempts) await sleepRandom(600 * attempt, 1_100 * attempt);
    }
  }
  throw new YTUploadError('step_advance', `step never advanced past ${currentStep} after ${maxAttempts} attempts`);
}

/**
 * Walk from the current step up to (and including) `targetStep` by
 * clicking Next. Adds a jittered pause between steps so the advance
 * cadence doesn't look like a script firing the button as fast as the
 * DOM allows.
 */
export async function advanceToStep(page: RawCdpPage, targetStep: number): Promise<number> {
  let step = await getCurrentStepIndex(page);
  if (step < 0) throw new YTUploadError('step_advance', 'wizard step badges not mounted');
  let guard = 0;
  while (step < targetStep) {
    // "Reading the step" pause before advancing.
    await sleepRandom(900, 2_200);
    step = await clickNextAndAwaitAdvance(page, step);
    if (++guard > 6) throw new YTUploadError('step_advance', `safety guard: too many advances trying to reach step ${targetStep}`);
  }
  return step;
}
