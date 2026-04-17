/**
 * Typed error hierarchy for YouTube CDP operations.
 *
 * Every failure surface in the youtube/ module throws one of these so
 * callers can distinguish "Studio's DOM shifted" from "user not logged
 * in" from "captcha mid-flow" without string-matching error messages.
 *
 * Base: YTError (everything else extends)
 *   - YTSessionError: couldn't reach Studio or profile resolution failed
 *   - YTLoginRequiredError: Studio bounced us to sign-in
 *   - YTChallengeError: 2FA / consent / reCAPTCHA / "verify it's you"
 *   - YTSelectorMissingError: a selector from selectors.ts didn't mount
 *   - YTTimeoutError: a wait exceeded its deadline
 *   - YTUploadError: upload flow-specific failure (file injection,
 *     step advance, visibility mismatch)
 *   - YTReadError: read-side scrape couldn't extract expected data
 */

export class YTError extends Error {
  constructor(message: string, public readonly meta: Record<string, unknown> = {}) {
    super(message);
    this.name = 'YTError';
  }
}

export class YTSessionError extends YTError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, meta);
    this.name = 'YTSessionError';
  }
}

export class YTLoginRequiredError extends YTError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, meta);
    this.name = 'YTLoginRequiredError';
  }
}

export type YTChallengeKind =
  | 'two_factor'
  | 'consent_screen'
  | 'recaptcha'
  | 'verify_its_you'
  | 'account_chooser'
  | 'suspicious_activity'
  | 'unknown';

export class YTChallengeError extends YTError {
  constructor(
    public readonly kind: YTChallengeKind,
    message: string,
    meta: Record<string, unknown> = {},
  ) {
    super(message, { ...meta, kind });
    this.name = 'YTChallengeError';
  }
}

export class YTSelectorMissingError extends YTError {
  constructor(
    public readonly selector: string,
    message: string,
    meta: Record<string, unknown> = {},
  ) {
    super(message, { ...meta, selector });
    this.name = 'YTSelectorMissingError';
  }
}

export class YTTimeoutError extends YTError {
  constructor(
    message: string,
    public readonly timeoutMs: number,
    meta: Record<string, unknown> = {},
  ) {
    super(message, { ...meta, timeoutMs });
    this.name = 'YTTimeoutError';
  }
}

export class YTUploadError extends YTError {
  constructor(
    public readonly stage: string,
    message: string,
    meta: Record<string, unknown> = {},
  ) {
    super(message, { ...meta, stage });
    this.name = 'YTUploadError';
  }
}

export class YTReadError extends YTError {
  constructor(
    public readonly what: string,
    message: string,
    meta: Record<string, unknown> = {},
  ) {
    super(message, { ...meta, what });
    this.name = 'YTReadError';
  }
}
