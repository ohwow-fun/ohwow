/**
 * Compatibility shim.
 *
 * The original _yt-browser.mjs lived here as a standalone helper. It
 * has been promoted to a typed module under
 * src/integrations/youtube/. This file re-exports the two public
 * entry points (ensureYTReady + uploadShort) against the new API so
 * yt-compose.mjs and any ad-hoc .mjs scripts keep working unchanged.
 *
 * New code should import from '../../src/integrations/youtube/index.ts'
 * directly.
 */
import { ensureYTStudio, uploadShort as uploadShortTyped, cancelUpload as cancelUploadTyped } from '../../src/integrations/youtube/index.ts';

/**
 * Returns { browser, page } with a live YouTube Studio tab.
 * Matches the original signature. Session health / challenge
 * detection runs internally; throws YTLoginRequiredError when the
 * session is unusable.
 */
export async function ensureYTReady() {
  const session = await ensureYTStudio();
  return { browser: session.browser, page: session.page };
}

/**
 * Upload a Short to YouTube via Studio.
 *
 * @param {import('../../src/execution/browser/raw-cdp.ts').RawCdpPage} page
 * @param {{ filePath: string, title: string, description?: string, visibility?: 'private'|'unlisted'|'public', screenshot?: boolean, dryRun?: boolean }} opts
 * @returns {Promise<{ videoUrl: string|null, visibility: string }>}
 */
export async function uploadShort(page, opts) {
  const result = await uploadShortTyped(page, {
    filePath: opts.filePath,
    title: opts.title,
    description: opts.description ?? '',
    visibility: opts.visibility ?? 'unlisted',
    dryRun: opts.dryRun ?? false,
  });
  return { videoUrl: result.videoUrl, visibility: result.visibility };
}

export async function cancelUpload(page) {
  return cancelUploadTyped(page);
}
