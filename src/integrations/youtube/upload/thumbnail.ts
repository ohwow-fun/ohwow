/**
 * Attach a custom thumbnail to the upload wizard's Details step (or
 * the per-video edit page — same component).
 *
 * Why this doesn't look like injectFile for the main video:
 *
 * The main <input name="Filedata"> accepts bare `DOM.setFileInputFiles`
 * because Studio's listener there doesn't check `event.isTrusted`.
 * The thumbnail uploader is stricter — both the "Upload file" button's
 * click handler and the hidden input's change handler reject untrusted
 * events. Empirically verified 2026-04-17: `input.click()` from JS,
 * `button.click()` from JS, and `setFileInputFiles` alone all leave
 * the input with zero files and no preview.
 *
 * The flow that works (what Playwright does internally for file
 * uploads, and what Studio's listener actually recognizes):
 *
 *   1. Page.setInterceptFileChooserDialog({ enabled: true })
 *      Browsers fire Page.fileChooserOpened instead of showing the
 *      native OS picker.
 *   2. Input.dispatchMouseEvent (mousePressed + mouseReleased) at the
 *      "Upload file" button's center coords. This is a *trusted*
 *      click, which Studio's handler accepts. The handler
 *      programmatically clicks the hidden <input type=file>, which
 *      fires Page.fileChooserOpened.
 *   3. The event carries a backendNodeId for the input element.
 *   4. DOM.setFileInputFiles with that backendNodeId delivers the
 *      file the way the OS picker would. Studio's change handler
 *      reads it and renders the preview.
 *   5. Disable interception so unrelated pickers (e.g. other stages)
 *      open normally.
 *
 * Note: `Page.handleFileChooser` (older CDP) is removed from Chrome
 * 147. Use `DOM.setFileInputFiles` with backendNodeId instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTUploadError } from '../errors.js';
import { SEL } from '../selectors.js';
import { waitForSelector } from '../wait.js';

const ACCEPT_EXT = new Set(['.jpg', '.jpeg', '.png']);

interface FileChooserOpenedParams {
  frameId: string;
  mode: string;
  backendNodeId: number;
}

export async function uploadThumbnail(page: RawCdpPage, thumbnailPath: string): Promise<void> {
  if (!fs.existsSync(thumbnailPath)) {
    throw new YTUploadError('upload_thumbnail', `thumbnail file not found: ${thumbnailPath}`, { thumbnailPath });
  }
  const ext = path.extname(thumbnailPath).toLowerCase();
  if (!ACCEPT_EXT.has(ext)) {
    throw new YTUploadError(
      'upload_thumbnail',
      `thumbnail must be .jpg/.jpeg/.png. got ${ext}`,
      { thumbnailPath },
    );
  }

  await waitForSelector(page, SEL.THUMBNAIL_SELECT_BUTTON, {
    timeoutMs: 8_000,
    label: 'thumbnail uploader',
  });

  // Resolve the "Upload file" button's click coords. The button is
  // inside <ytcp-thumbnail-uploader>; multiple #select-button elements
  // exist on the edit page (Auto-generated panel uses the same id),
  // so we must filter to the one with aria-label="Upload file".
  const coords = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    for (const btn of document.querySelectorAll(${JSON.stringify(SEL.THUMBNAIL_SELECT_BUTTON)})) {
      if (btn.offsetParent !== null && btn.getAttribute('aria-label') === 'Upload file') {
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  })()`);
  if (!coords) {
    throw new YTUploadError('upload_thumbnail', 'Upload file button not found or not visible');
  }

  await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    const chooserReady = page.waitForEvent<FileChooserOpenedParams>('Page.fileChooserOpened', 6_000);

    // Trusted mouse click — Studio's handler rejects untrusted (JS .click())
    // events, so we must go through the Input domain.
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1,
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1,
    });

    const chooserEvent = await chooserReady;
    if (!chooserEvent.backendNodeId) {
      throw new YTUploadError('upload_thumbnail', 'fileChooserOpened fired without backendNodeId');
    }

    await page.send('DOM.setFileInputFiles', {
      files: [thumbnailPath],
      backendNodeId: chooserEvent.backendNodeId,
    });
  } finally {
    await page.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }

  // Studio renders a data:image/jpeg preview within ~1s of delivery.
  // The longer wait covers image-processing edge cases (larger files).
  await new Promise((r) => setTimeout(r, 1_500));
}
