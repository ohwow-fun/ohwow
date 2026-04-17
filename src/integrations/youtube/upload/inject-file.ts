/**
 * Inject a file into Studio's upload <input type="file"> via
 * CDP DOM.setFileInputFiles. Bypasses the native picker entirely.
 *
 * Two strategies tried in order:
 *   1. DOM.querySelectorAll on the root document node — works when the
 *      input lives in the main DOM.
 *   2. Runtime.evaluate + DOM.requestNode to grab the input as a
 *      DOM node id via its object — handles Shadow DOM cases (Studio
 *      occasionally renders the input inside a custom element tree).
 */

import fs from 'node:fs';
import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTUploadError } from '../errors.js';
import { SEL } from '../selectors.js';

export async function injectFile(page: RawCdpPage, filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new YTUploadError('inject_file', `video file not found: ${filePath}`, { filePath });
  }

  await page.send('DOM.enable');
  const doc = await page.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });

  const qsa = await page.send<{ nodeIds: number[] }>('DOM.querySelectorAll', {
    nodeId: doc.root.nodeId,
    selector: SEL.UPLOAD_FILE_INPUT,
  });
  if (qsa.nodeIds.length > 0) {
    await page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: qsa.nodeIds[0] });
    return;
  }

  // Shadow DOM fallback — evaluate without returnByValue to get an objectId,
  // then requestNode to convert to a DOM nodeId.
  const objResult = await page.send<{ result: { objectId?: string } }>('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(SEL.UPLOAD_FILE_INPUT)})`,
    returnByValue: false,
  });
  if (objResult.result?.objectId) {
    const domNode = await page.send<{ nodeId: number }>('DOM.requestNode', { objectId: objResult.result.objectId });
    await page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: domNode.nodeId });
    return;
  }

  throw new YTUploadError('inject_file', 'could not locate file input in upload dialog');
}
