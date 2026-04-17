/**
 * YouTube integration — public surface.
 *
 * All callers should import from this file rather than subpaths so
 * we can reshape internals without breaking downstream code.
 */

export {
  YTError,
  YTSessionError,
  YTLoginRequiredError,
  YTChallengeError,
  YTSelectorMissingError,
  YTTimeoutError,
  YTUploadError,
  YTReadError,
  type YTChallengeKind,
} from './errors.js';

export { SEL, type SelKey } from './selectors.js';

export { waitForSelector, waitForNoSelector, waitForPredicate, waitForText, waitForSelectorStable, type WaitOptions } from './wait.js';

export { detectChallenge, dismissWelcomeDialog, type YTChallenge } from './challenges.js';

export {
  ensureYTStudio,
  healthCheck,
  DEFAULT_CDP_PORT,
  type EnsureYTStudioOptions,
  type YTSession,
  type YTHealth,
} from './session.js';

export {
  uploadShort,
  cancelUpload,
  type UploadShortOptions,
  type UploadResult,
  type UploadStage,
  type UploadStageEvent,
} from './upload/index.js';

export { type Visibility } from './upload/visibility.js';
