import { describe, expect, it } from 'vitest';

import {
  YTChallengeError,
  YTError,
  YTLoginRequiredError,
  YTReadError,
  YTSelectorMissingError,
  YTSessionError,
  YTTimeoutError,
  YTUploadError,
} from '../errors.js';

describe('YT error hierarchy', () => {
  it('every subclass extends YTError and sets its own name', () => {
    const cases: Array<[Error, string]> = [
      [new YTSessionError('x'), 'YTSessionError'],
      [new YTLoginRequiredError('x'), 'YTLoginRequiredError'],
      [new YTChallengeError('two_factor', 'x'), 'YTChallengeError'],
      [new YTSelectorMissingError('#foo', 'x'), 'YTSelectorMissingError'],
      [new YTTimeoutError('x', 1000), 'YTTimeoutError'],
      [new YTUploadError('dialog_open', 'x'), 'YTUploadError'],
      [new YTReadError('video_metadata', 'x'), 'YTReadError'],
    ];
    for (const [err, name] of cases) {
      expect(err).toBeInstanceOf(YTError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
    }
  });

  it('YTChallengeError exposes the challenge kind on the instance and in meta', () => {
    const err = new YTChallengeError('recaptcha', 'captcha in the way');
    expect(err.kind).toBe('recaptcha');
    expect(err.meta.kind).toBe('recaptcha');
  });

  it('YTSelectorMissingError exposes selector on instance and meta', () => {
    const err = new YTSelectorMissingError('#next-button', 'never mounted');
    expect(err.selector).toBe('#next-button');
    expect(err.meta.selector).toBe('#next-button');
  });

  it('YTTimeoutError exposes timeoutMs on instance and meta', () => {
    const err = new YTTimeoutError('slow', 5000, { where: 'wait' });
    expect(err.timeoutMs).toBe(5000);
    expect(err.meta).toMatchObject({ timeoutMs: 5000, where: 'wait' });
  });

  it('YTUploadError exposes stage on instance and meta', () => {
    const err = new YTUploadError('step_advance', 'stuck');
    expect(err.stage).toBe('step_advance');
    expect(err.meta.stage).toBe('step_advance');
  });

  it('YTReadError exposes what on instance and meta', () => {
    const err = new YTReadError('analytics_overview', 'no cards');
    expect(err.what).toBe('analytics_overview');
    expect(err.meta.what).toBe('analytics_overview');
  });

  it('preserves caller-supplied meta alongside synthetic fields', () => {
    const err = new YTUploadError('dialog_open', 'nope', { attempt: 3 });
    expect(err.meta).toEqual({ stage: 'dialog_open', attempt: 3 });
  });
});
