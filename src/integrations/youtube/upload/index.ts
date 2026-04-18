/**
 * Studio upload orchestrator — drives the full wizard.
 *
 * Stages (in order):
 *   dialog_open → file_injected → processing_started → title_filled →
 *   description_filled → not_for_kids_set → step_advanced:N →
 *   visibility_set → url_extracted → (save_clicked | dry_run_exit) →
 *   processing_dialog_closed
 *
 * Each stage emits a structured event via the supplied `onStage`
 * callback (also logged at debug level). Callers can observe partial
 * success state on failure — e.g. upload completed to YouTube but the
 * final Save click was blocked by a consent popup.
 *
 * dryRun: true walks every wizard stage up through url_extracted, then
 * closes the dialog. The file + metadata have been uploaded by that
 * point — Studio auto-saves them as a draft in Content → Drafts. The
 * returned videoId is real and stable; the draft is not public, but it
 * exists and must be explicitly cleaned up (see drafts.ts). This mode
 * was misleadingly documented for a long time; see README for details.
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { logger } from '../../../lib/logger.js';
import { detectChallenge, type YTChallenge } from '../challenges.js';
import { YTChallengeError, YTUploadError } from '../errors.js';
import { closeAnyOpenDialog, openUploadDialog } from './open-dialog.js';
import { fillDescription, fillTitle, setNotMadeForKids } from './fill-metadata.js';
import { readTime, sleepRandom } from './human.js';
import { injectFile } from './inject-file.js';
import { selectPlaylist, type PlaylistVisibility } from './playlist.js';
import { uploadThumbnail } from './thumbnail.js';
import { clickSave, dismissProcessingDialog, extractVideoUrl, selectVisibility, type Visibility } from './visibility.js';
import { advanceToStep } from './wizard.js';

export type UploadStage =
  | 'dialog_open'
  | 'file_injected'
  | 'processing_started'
  | 'title_filled'
  | 'description_filled'
  | 'thumbnail_attached'
  | 'playlist_set'
  | 'not_for_kids_set'
  | 'step_advanced'
  | 'visibility_set'
  | 'url_extracted'
  | 'save_clicked'
  | 'dry_run_exit'
  | 'processing_dialog_closed';

export interface UploadStageEvent {
  stage: UploadStage;
  ok: boolean;
  durationMs: number;
  meta?: Record<string, unknown>;
  error?: string;
}

export interface UploadShortOptions {
  filePath: string;
  title: string;
  description?: string;
  /**
   * Custom thumbnail (JPEG/PNG, target 1280×720, ≤2MB). Attached on the
   * Details step after description. Omit to keep Studio's auto-generated
   * frame-grab thumbnail.
   */
  thumbnailPath?: string;
  /**
   * Playlist to bind this upload to. Exact name as it appears in Studio
   * (case-insensitive match against existing rows). Resolved on the
   * Details step after thumbnail_attached, before not_for_kids_set.
   */
  playlist?: string;
  /** Create the playlist if no row matches. Default false (fail loud). */
  createPlaylistIfMissing?: boolean;
  /** Visibility for a newly-created playlist. Default 'unlisted'. */
  createPlaylistVisibility?: PlaylistVisibility;
  /**
   * Explicit escape hatch: skip the playlist stage entirely, even if
   * `playlist` is set. Use when Studio's playlist picker is flaky on a
   * given profile and the caller wants to proceed without binding.
   * The `_publish-briefing.mjs --no-playlist` CLI flag maps to this.
   */
  skipPlaylist?: boolean;
  visibility?: Visibility;
  /** When true, stop before clicking Save and close the dialog. */
  dryRun?: boolean;
  /**
   * Called on every stage transition. Use to stream progress to a
   * caller (CLI, orchestrator, future tool).
   */
  onStage?: (event: UploadStageEvent) => void;
  /** How many wizard steps to advance to reach visibility. Default 3. */
  visibilityStepIndex?: number;
  /**
   * Probe for challenges (2FA, captcha, consent) between stages and
   * raise YTChallengeError if any appear. Default true.
   */
  probeChallenges?: boolean;
}

export interface UploadResult {
  videoUrl: string | null;
  visibility: Visibility;
  dryRun: boolean;
  /** Full stage timeline for debugging. */
  stages: UploadStageEvent[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Whether the playlist stage should run for these options. Exported for
 * unit tests — pure predicate, no side effects. Playlist runs only when
 * a name is provided AND the caller has not opted out via skipPlaylist.
 */
export function shouldRunPlaylistStage(opts: Pick<UploadShortOptions, 'playlist' | 'skipPlaylist'>): boolean {
  if (opts.skipPlaylist) return false;
  if (!opts.playlist) return false;
  return true;
}

export async function uploadShort(page: RawCdpPage, opts: UploadShortOptions): Promise<UploadResult> {
  const visibility = opts.visibility ?? 'unlisted';
  const visibilityStepIndex = opts.visibilityStepIndex ?? 3;
  const probeChallenges = opts.probeChallenges ?? true;
  const stages: UploadStageEvent[] = [];

  async function stage<T>(name: UploadStage, meta: Record<string, unknown> | undefined, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const ev: UploadStageEvent = { stage: name, ok: true, durationMs: Date.now() - start, meta };
      stages.push(ev);
      opts.onStage?.(ev);
      logger.debug({ ...ev }, '[youtube/upload] stage ok');
      return result;
    } catch (err) {
      const ev: UploadStageEvent = {
        stage: name,
        ok: false,
        durationMs: Date.now() - start,
        meta,
        error: err instanceof Error ? err.message : String(err),
      };
      stages.push(ev);
      opts.onStage?.(ev);
      logger.warn({ ...ev }, '[youtube/upload] stage failed');
      throw err;
    }
  }

  async function assertNoChallenge(): Promise<YTChallenge | null> {
    if (!probeChallenges) return null;
    const ch = await detectChallenge(page);
    if (ch) {
      throw new YTChallengeError(ch.kind, `challenge mid-upload: ${ch.detail}. ${ch.remediation}`, { challenge: ch });
    }
    return null;
  }

  await stage('dialog_open', undefined, () => openUploadDialog(page));
  // A person opens the dialog, then looks for the file they want.
  await sleepRandom(700, 1_800);
  await stage('file_injected', { filePath: opts.filePath }, () => injectFile(page, opts.filePath));

  // After file injection, Studio spins up processing AND async-autofills
  // the title textbox from the filename. We must wait for that autofill
  // to LAND before fillTitle runs — otherwise Studio overwrites our
  // title a few hundred ms later and the saved draft keeps the filename.
  // This is what went wrong on 2026-04-17: title_filled landed in 9ms
  // because the textbox existed, but Studio's autofill reverted it.
  await stage('processing_started', undefined, async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await page.evaluate<{ present: boolean; hasContent: boolean }>(
        `(() => {
          const el = document.querySelector('#title-textarea #textbox');
          return { present: !!el, hasContent: el ? (el.textContent || '').trim().length > 0 : false };
        })()`,
      );
      if (state.hasContent) return;
      await sleep(250);
    }
    throw new YTUploadError('processing_started', 'title box never populated by Studio autofill');
  });

  await assertNoChallenge();

  // "Reading the Details step that just appeared" pause — scales to
  // how much text will be typed.
  await sleepRandom(readTime(40), readTime(80));
  await stage('title_filled', { title: opts.title }, () => fillTitle(page, opts.title));

  if (opts.description) {
    // "Clicking into the description" pause.
    await sleepRandom(500, 1_200);
    await stage('description_filled', { length: opts.description.length }, () => fillDescription(page, opts.description!));
  }

  if (opts.thumbnailPath) {
    // "Scrolling to the thumbnail section" pause.
    await sleepRandom(700, 1_600);
    await stage('thumbnail_attached', { thumbnailPath: opts.thumbnailPath }, () =>
      uploadThumbnail(page, opts.thumbnailPath!),
    );
  }

  if (shouldRunPlaylistStage(opts)) {
    // "Scrolling to the playlist section" pause.
    await sleepRandom(600, 1_400);
    await stage('playlist_set', { playlist: opts.playlist }, async () => {
      const result = await selectPlaylist(page, {
        name: opts.playlist!,
        createIfMissing: opts.createPlaylistIfMissing,
        createVisibility: opts.createPlaylistVisibility,
      });
      return result;
    });
  }

  // "Scrolling to the Audience section" pause.
  await sleepRandom(800, 1_800);
  await stage('not_for_kids_set', undefined, () => setNotMadeForKids(page));

  // Let Studio flush autosave after contenteditable edits, then take
  // a realistic "scanning for the Next button" pause.
  await sleepRandom(600, 1_400);

  const finalStep = await stage('step_advanced', { target: visibilityStepIndex }, () =>
    advanceToStep(page, visibilityStepIndex),
  );
  logger.debug({ finalStep }, '[youtube/upload] reached visibility step');

  await assertNoChallenge();

  // "Reading the Visibility step options" pause.
  await sleepRandom(900, 2_200);
  await stage('visibility_set', { visibility }, () => selectVisibility(page, visibility));

  // Small pause before URL extraction — DOM scan is near-instant, this
  // keeps the surrounding cadence human.
  await sleepRandom(400, 900);
  const videoUrl = await stage('url_extracted', undefined, () => extractVideoUrl(page));

  if (opts.dryRun) {
    // "Deciding to close without publishing" pause.
    await sleepRandom(600, 1_400);
    await stage('dry_run_exit', { wouldPublishAs: visibility, wouldBeUrl: videoUrl }, async () => {
      await closeAnyOpenDialog(page);
    });
    return { videoUrl, visibility, dryRun: true, stages };
  }

  await stage('save_clicked', undefined, () => clickSave(page));
  // Studio shows a processing-confirmation dialog after publish.
  await sleepRandom(1_400, 2_400);
  await stage('processing_dialog_closed', undefined, async () => {
    await dismissProcessingDialog(page);
  });

  return { videoUrl, visibility, dryRun: false, stages };
}

/** Close the upload dialog without publishing. */
export async function cancelUpload(page: RawCdpPage): Promise<void> {
  await closeAnyOpenDialog(page);
}
