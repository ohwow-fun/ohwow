/**
 * Challenge + auth-state detection for YouTube Studio.
 *
 * Before each risky step in an upload or scrape, the caller runs
 * detectChallenge(page) to see whether Google has thrown up a
 * challenge (2FA, consent banner, account chooser, reCAPTCHA) or
 * bounced the session to sign-in. Returns `null` on healthy state.
 *
 * Detection strategy:
 *   1. URL-based fast path: sign-in/consent/challenge live at well-
 *      known Google URLs. A single location.href check catches most
 *      session losses in 1 DOM evaluate.
 *   2. DOM fallback: for challenges that appear in-place (welcome
 *      dialogs, interstitial captchas), look for signature selectors.
 *
 * Detection is READ-ONLY. It never clicks, submits, or navigates.
 * Callers decide remediation (raise to user, retry after sleep, abort).
 */

import type { RawCdpPage } from '../../execution/browser/raw-cdp.js';
import type { YTChallengeKind } from './errors.js';
import { SEL } from './selectors.js';

export interface YTChallenge {
  kind: YTChallengeKind;
  /** Human-readable summary for logs + error messages. */
  detail: string;
  /** Current URL when the challenge was observed. */
  url: string;
  /** Suggested remediation for the caller to surface. */
  remediation: string;
}

/**
 * Inspect the page for any blocking challenge. Returns null when
 * Studio looks healthy. Never throws — all DOM errors are coerced to
 * the 'unknown' kind so the caller never crashes on a shifted selector
 * inside a detector.
 */
export async function detectChallenge(page: RawCdpPage): Promise<YTChallenge | null> {
  let url = '';
  try {
    url = await page.url();
  } catch {
    return { kind: 'unknown', detail: 'could not read page URL', url: '', remediation: 'check CDP connection' };
  }

  // --- URL-based detection (fast path) ------------------------------------
  // Order matters — more specific checks first so e.g. a /signin/challenge
  // URL doesn't get misclassified as a generic "signed out".
  const u = url.toLowerCase();
  if (u.includes('/signin/challenge/') || u.includes('signin/v2/challenge')) {
    return {
      kind: 'two_factor',
      detail: 'Google 2FA / verification challenge',
      url,
      remediation: '2-step verification needed — complete the challenge in the browser, then retry',
    };
  }
  if (/\/accounts\.google\.com\/servicelogin/.test(u) || /accounts\.google\.com\/v\d+\/signin/.test(u)) {
    return {
      kind: 'unknown',
      detail: 'redirected to Google sign-in',
      url,
      remediation: 'the profile is signed out — sign back into YouTube in the Chrome profile, then retry',
    };
  }
  if (u.includes('consent.google') || u.includes('consent.youtube') || u.includes('/consent?')) {
    return {
      kind: 'consent_screen',
      detail: 'Google consent screen',
      url,
      remediation: 'accept the consent prompt manually, then retry',
    };
  }
  if (u.includes('accounts.google.com/accountchooser') || u.includes('accounts.google.com/signin/v2/identifier')) {
    return {
      kind: 'account_chooser',
      detail: 'Google account chooser',
      url,
      remediation: 'the profile has multiple accounts — select the right one manually, then retry',
    };
  }
  if (u.includes('/signin/v2/identifier') && u.includes('verifyidentity')) {
    return {
      kind: 'verify_its_you',
      detail: '"verify it\'s you" interstitial',
      url,
      remediation: 'complete the verification manually, then retry',
    };
  }
  if (u.includes('/ServiceLoginAuth') || u.includes('sorry.google.com')) {
    return {
      kind: 'suspicious_activity',
      detail: 'suspicious-activity / blocked request page',
      url,
      remediation: 'Google has flagged the session — open the profile in a real browser and resolve the warning',
    };
  }

  // --- DOM-based detection (in-place captchas, interstitials) -------------
  let domProbe: { recaptcha: boolean; twoFactor: boolean; consentBtn: boolean; verifyItsYou: boolean; signInForm: boolean };
  try {
    domProbe = await page.evaluate<typeof domProbe>(`(() => ({
      recaptcha: !!document.querySelector(${JSON.stringify(SEL.CHALLENGE_RECAPTCHA_IFRAME)}),
      twoFactor: !!document.querySelector(${JSON.stringify(SEL.CHALLENGE_TWO_FACTOR)}),
      consentBtn: !!document.querySelector(${JSON.stringify(SEL.CHALLENGE_CONSENT_AGREE)}),
      verifyItsYou: !!document.querySelector(${JSON.stringify(SEL.CHALLENGE_VERIFY_ITS_YOU)}),
      signInForm: !!document.querySelector(${JSON.stringify(SEL.AUTH_SIGNIN_FORM)}),
    }))()`);
  } catch {
    return null;
  }

  if (domProbe.recaptcha) {
    return {
      kind: 'recaptcha',
      detail: 'reCAPTCHA iframe present',
      url,
      remediation: 'solve the captcha manually, then retry',
    };
  }
  if (domProbe.signInForm) {
    return {
      kind: 'unknown',
      detail: 'sign-in form present in DOM',
      url,
      remediation: 'session is dead — sign back in manually and retry',
    };
  }
  if (domProbe.twoFactor) {
    return {
      kind: 'two_factor',
      detail: '2FA form detected in DOM',
      url,
      remediation: 'complete 2-step verification manually, then retry',
    };
  }
  if (domProbe.verifyItsYou) {
    return {
      kind: 'verify_its_you',
      detail: '"verify it\'s you" prompt detected in DOM',
      url,
      remediation: 'complete the verification manually, then retry',
    };
  }
  if (domProbe.consentBtn) {
    return {
      kind: 'consent_screen',
      detail: 'consent screen accept button present',
      url,
      remediation: 'accept the consent prompt manually, then retry',
    };
  }

  return null;
}

/**
 * Dismiss the Studio first-run welcome dialog if it's mounted.
 * Idempotent no-op otherwise. Safe to call at the start of every
 * session.
 */
export async function dismissWelcomeDialog(page: RawCdpPage): Promise<boolean> {
  const closed = await page.evaluate<boolean>(`(() => {
    const btn = document.querySelector(${JSON.stringify(SEL.DIALOG_WELCOME_CLOSE)});
    if (btn && btn instanceof HTMLElement) { btn.click(); return true; }
    return false;
  })()`);
  return closed;
}
