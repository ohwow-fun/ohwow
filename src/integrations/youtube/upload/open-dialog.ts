/**
 * Open the Studio Create → Upload videos dialog.
 *
 * Retries twice on transient failure (Create menu mounted but not
 * clickable yet, menu items not populated, dialog mounts but without
 * file input). Every attempt is a full sequence: close any open
 * dialogs → click Create → click "Upload videos" → assert file input
 * is present.
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTUploadError } from '../errors.js';
import { SEL } from '../selectors.js';
import { waitForNoSelector, waitForSelector } from '../wait.js';
import { humanClickAt, humanClickSelector, sleepRandom } from './human.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Close any upload dialog + its discard confirmation. Idempotent — safe
 * to call even when nothing is open.
 */
export async function closeAnyOpenDialog(page: RawCdpPage): Promise<void> {
  await page.evaluate<string>(`(() => {
    const btn = document.querySelector(${JSON.stringify(SEL.UPLOAD_DIALOG_CLOSE_BUTTON)});
    if (btn && btn instanceof HTMLElement && btn.offsetParent !== null) { btn.click(); return 'closed'; }
    return 'none';
  })()`);
  // Discard confirmation may appear after close click; dismiss it too.
  await sleep(500);
  await page.evaluate<string>(`(() => {
    const btn = document.querySelector(${JSON.stringify(SEL.DIALOG_DISCARD_BUTTON)});
    if (btn && btn instanceof HTMLElement) { btn.click(); return 'discarded'; }
    return 'none';
  })()`);
  // Wait for the upload dialog to actually be gone (best-effort, 3s ceiling).
  try {
    await waitForNoSelector(page, SEL.UPLOAD_FILE_INPUT, { timeoutMs: 3_000, label: 'upload dialog close' });
  } catch {
    // Non-fatal — maybe no dialog was open to begin with.
  }
}

/**
 * Open the upload dialog. Returns nothing on success; throws
 * YTUploadError on failure.
 *
 * Attempts:
 *  1. Close any already-open dialog.
 *  2. Wait for Create button to be visible.
 *  3. Click Create, wait for menu to mount.
 *  4. Click "Upload videos" menu item (text match, since id is unstable).
 *  5. Wait for the dialog's file input to be in the DOM.
 */
export async function openUploadDialog(page: RawCdpPage, maxAttempts = 3): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await closeAnyOpenDialog(page);

      await waitForSelector(page, SEL.UPLOAD_CREATE_BUTTON, { visible: true, timeoutMs: 8_000, label: 'Create button' });
      // Trusted click on Create (anti-detection), then the natural
      // "wait for the menu to render" pause before picking an item.
      await humanClickSelector(page, SEL.UPLOAD_CREATE_BUTTON, { label: 'Create button' });

      await waitForSelector(page, SEL.UPLOAD_MENU_ITEM_READY, { timeoutMs: 5_000, label: 'Create menu items' });
      await sleepRandom(300, 700);

      const uploadCoords = await page.evaluate<{ x: number; y: number } | null>(`(() => {
        const items = document.querySelectorAll(${JSON.stringify(SEL.UPLOAD_MENU_ITEMS)});
        for (const item of items) {
          if (item.offsetParent === null) continue;
          if (!/upload video/i.test(item.textContent || '')) continue;
          const r = item.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      })()`);
      if (!uploadCoords) throw new YTUploadError('open_dialog', '"Upload videos" menu item not found');
      await humanClickAt(page, uploadCoords.x, uploadCoords.y);

      // Dialog + file input mounted.
      await waitForSelector(page, SEL.UPLOAD_FILE_INPUT, { timeoutMs: 8_000, label: 'upload file input' });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) await sleep(500 * attempt);
    }
  }
  throw new YTUploadError(
    'open_dialog',
    `failed to open upload dialog after ${maxAttempts} attempts: ${lastError?.message ?? 'unknown'}`,
    { cause: lastError?.message },
  );
}
