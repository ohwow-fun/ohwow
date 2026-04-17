import { describe, expect, it } from 'vitest';

import { detectChallenge, dismissWelcomeDialog } from '../challenges.js';

/**
 * detectChallenge reads location.href first, then does a single DOM
 * probe. Mock the page's url() + evaluate() to return predetermined
 * states and assert the right classification comes out.
 */

type MockState = {
  url: string;
  dom?: Partial<{
    recaptcha: boolean;
    twoFactor: boolean;
    consentBtn: boolean;
    verifyItsYou: boolean;
    signInForm: boolean;
  }>;
};

function mockPage(state: MockState): any {
  const dom = { recaptcha: false, twoFactor: false, consentBtn: false, verifyItsYou: false, signInForm: false, ...state.dom };
  return {
    url: async () => state.url,
    evaluate: async () => dom,
  };
}

describe('detectChallenge — URL-based fast path', () => {
  it('returns null on a healthy Studio URL', async () => {
    const page = mockPage({ url: 'https://studio.youtube.com/channel/UCfoo/edit' });
    expect(await detectChallenge(page)).toBeNull();
  });

  it('detects redirect to Google sign-in', async () => {
    const page = mockPage({ url: 'https://accounts.google.com/ServiceLogin?continue=…' });
    const ch = await detectChallenge(page);
    expect(ch).not.toBeNull();
    expect(ch!.detail).toMatch(/sign-in/i);
  });

  it('classifies 2FA / signin challenge URL', async () => {
    const page = mockPage({ url: 'https://accounts.google.com/signin/v2/challenge/pwd?authuser=0' });
    const ch = await detectChallenge(page);
    expect(ch!.kind).toBe('two_factor');
  });

  it('classifies consent screen URL', async () => {
    const page = mockPage({ url: 'https://consent.google.com/signin?continue=…' });
    const ch = await detectChallenge(page);
    expect(ch!.kind).toBe('consent_screen');
  });

  it('classifies account-chooser URL', async () => {
    const page = mockPage({ url: 'https://accounts.google.com/AccountChooser?continue=…' });
    const ch = await detectChallenge(page);
    expect(ch!.kind).toBe('account_chooser');
  });

  it('classifies suspicious-activity page', async () => {
    const page = mockPage({ url: 'https://sorry.google.com/sorry/index' });
    const ch = await detectChallenge(page);
    expect(ch!.kind).toBe('suspicious_activity');
  });
});

describe('detectChallenge — DOM fallback', () => {
  const STUDIO = 'https://studio.youtube.com/channel/UCfoo';

  it('flags reCAPTCHA when iframe is present', async () => {
    const page = mockPage({ url: STUDIO, dom: { recaptcha: true } });
    const ch = await detectChallenge(page);
    expect(ch!.kind).toBe('recaptcha');
  });

  it('flags a DOM 2FA form when mounted in-place', async () => {
    const page = mockPage({ url: STUDIO, dom: { twoFactor: true } });
    const ch = await detectChallenge(page);
    expect(ch!.kind).toBe('two_factor');
  });

  it('flags sign-in form present in DOM', async () => {
    const page = mockPage({ url: STUDIO, dom: { signInForm: true } });
    const ch = await detectChallenge(page);
    expect(ch).not.toBeNull();
    expect(ch!.detail).toMatch(/sign-in form/i);
  });

  it('flags consent agree button present', async () => {
    const page = mockPage({ url: STUDIO, dom: { consentBtn: true } });
    const ch = await detectChallenge(page);
    expect(ch!.kind).toBe('consent_screen');
  });

  it('flags verify-its-you prompt', async () => {
    const page = mockPage({ url: STUDIO, dom: { verifyItsYou: true } });
    const ch = await detectChallenge(page);
    expect(ch!.kind).toBe('verify_its_you');
  });

  it('returns null when both URL and DOM look healthy', async () => {
    const page = mockPage({ url: STUDIO });
    expect(await detectChallenge(page)).toBeNull();
  });
});

describe('detectChallenge — error resilience', () => {
  it('returns a generic unknown kind when url() throws', async () => {
    const page = { url: async () => { throw new Error('wsclosed'); }, evaluate: async () => ({}) };
    const ch = await detectChallenge(page as any);
    expect(ch).not.toBeNull();
    expect(ch!.kind).toBe('unknown');
  });

  it('returns null when DOM probe throws (best-effort)', async () => {
    const page = {
      url: async () => 'https://studio.youtube.com/channel/UCfoo',
      evaluate: async () => { throw new Error('evalfail'); },
    };
    expect(await detectChallenge(page as any)).toBeNull();
  });
});

describe('dismissWelcomeDialog', () => {
  it('returns false when no dialog is mounted', async () => {
    const page = { evaluate: async () => false };
    expect(await dismissWelcomeDialog(page as any)).toBe(false);
  });

  it('returns true when the dialog was clicked', async () => {
    const page = { evaluate: async () => true };
    expect(await dismissWelcomeDialog(page as any)).toBe(true);
  });
});
