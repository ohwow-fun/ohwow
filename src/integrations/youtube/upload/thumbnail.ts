/**
 * Attach a custom thumbnail to the upload wizard's Details step.
 *
 * The thumbnail uploader (<ytcp-thumbnail-uploader>) mounts on the
 * Details step alongside the title/description boxes. It exposes a
 * hidden `<input type="file" accept="image/jpeg,image/png">` that we
 * drive via the same CDP DOM.setFileInputFiles trick the main video
 * input uses — no native picker, no click simulation.
 *
 * YouTube accepts JPEG or PNG, target 1280×720 (16:9), ≤2MB. The
 * caller owns image authorship (frame-grab from ffmpeg or a dedicated
 * Remotion composition) — this function just injects whatever path
 * it's handed after verifying Studio's input node mounted.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTUploadError } from '../errors.js';
import { SEL } from '../selectors.js';
import { waitForSelector } from '../wait.js';
import { injectFile } from './inject-file.js';

const ACCEPT_EXT = new Set(['.jpg', '.jpeg', '.png']);

export async function uploadThumbnail(page: RawCdpPage, thumbnailPath: string): Promise<void> {
  if (!fs.existsSync(thumbnailPath)) {
    throw new YTUploadError('upload_thumbnail', `thumbnail file not found: ${thumbnailPath}`, { thumbnailPath });
  }
  const ext = path.extname(thumbnailPath).toLowerCase();
  if (!ACCEPT_EXT.has(ext)) {
    throw new YTUploadError(
      'upload_thumbnail',
      `thumbnail must be .jpg/.jpeg/.png (Studio's accept attr). got ${ext}`,
      { thumbnailPath },
    );
  }

  // Wait for the thumbnail slot to mount before injecting. The Details
  // step is where this lives; callers must have reached that step.
  await waitForSelector(page, SEL.THUMBNAIL_SELECT_BUTTON, {
    timeoutMs: 8_000,
    label: 'thumbnail uploader',
  });

  await injectFile(page, thumbnailPath, SEL.THUMBNAIL_FILE_INPUT);

  // Studio renders a thumbnail preview immediately after the file is
  // assigned; no further interaction needed to commit it to the draft.
  // Give the uploader a beat to flush state before the caller advances.
  await new Promise((r) => setTimeout(r, 400));
}
