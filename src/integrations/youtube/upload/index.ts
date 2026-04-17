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
 * dryRun: true stops AFTER url_extracted and AFTER cancelUpload (so
 * the dialog is left closed, nothing has been committed to the channel).
 * Used by yt-dry-run.mjs to validate the full path without publishing.
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { logger } from '../../../lib/logger.js';
import { detectChallenge, type YTChallenge } from '../challenges.js';
import { YTChallengeError, YTUploadError } from '../errors.js';
import { closeAnyOpenDialog, openUploadDialog } from './open-dialog.js';
import { fillDescription, fillTitle, setNotMadeForKids } from './fill-metadata.js';
import { injectFile } from './inject-file.js';
import { clickSave, dismissProcessingDialog, extractVideoUrl, selectVisibility, type Visibility } from './visibility.js';
import { advanceToStep } from './wizard.js';

export type UploadStage =
  | 'dialog_open'
  | 'file_injected'
  | 'processing_started'
  | 'title_filled'
  | 'description_filled'
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
  await stage('file_injected', { filePath: opts.filePath }, () => injectFile(page, opts.filePath));

  // After file injection, Studio spins up processing. Give it a beat
  // to mount progress UI + auto-populate title from filename. We wait
  // on the metadata step's title box (which is our signal that the
  // wizard has moved past "just selecting a file").
  await stage('processing_started', undefined, async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const present = await page.evaluate<boolean>(
        `(() => !!document.querySelector('#title-textarea #textbox'))()`,
      );
      if (present) return;
      await sleep(250);
    }
    throw new YTUploadError('processing_started', 'title box never mounted after file injection');
  });

  await assertNoChallenge();

  await stage('title_filled', { title: opts.title }, () => fillTitle(page, opts.title));
  if (opts.description) {
    await stage('description_filled', { length: opts.description.length }, () => fillDescription(page, opts.description!));
  }
  await stage('not_for_kids_set', undefined, () => setNotMadeForKids(page));

  // Give Studio a moment to flush autosave after contenteditable edits.
  await sleep(500);

  const finalStep = await stage('step_advanced', { target: visibilityStepIndex }, () =>
    advanceToStep(page, visibilityStepIndex),
  );
  logger.debug({ finalStep }, '[youtube/upload] reached visibility step');

  await assertNoChallenge();

  await stage('visibility_set', { visibility }, () => selectVisibility(page, visibility));
  const videoUrl = await stage('url_extracted', undefined, () => extractVideoUrl(page));

  if (opts.dryRun) {
    await stage('dry_run_exit', { wouldPublishAs: visibility, wouldBeUrl: videoUrl }, async () => {
      await closeAnyOpenDialog(page);
    });
    return { videoUrl, visibility, dryRun: true, stages };
  }

  await stage('save_clicked', undefined, () => clickSave(page));
  // Studio shows a processing-confirmation dialog after publish.
  await sleep(1_500);
  await stage('processing_dialog_closed', undefined, async () => {
    await dismissProcessingDialog(page);
  });

  return { videoUrl, visibility, dryRun: false, stages };
}

/** Close the upload dialog without publishing. */
export async function cancelUpload(page: RawCdpPage): Promise<void> {
  await closeAnyOpenDialog(page);
}
