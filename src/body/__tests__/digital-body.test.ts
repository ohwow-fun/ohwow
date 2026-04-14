/**
 * Tests for the DigitalBody organ adapters — focused on the BaseOrgan
 * dormant-vs-failed distinction added in response to proprioception bench
 * P3.11. The bug: every organ with a default getHealth() collapsed
 * "never started" and "started then died" into the same `dormant` state,
 * so killing voicebox left the Voice organ reporting `dormant` instead of
 * `failed` even after it had been alive for the entire daemon lifetime.
 */

import { describe, it, expect } from 'vitest';
import { DigitalBody, type VoiceServiceLike, type BrowserServiceLike } from '../digital-body.js';

function makeStubVoice(initialActive: boolean): VoiceServiceLike & { setActive(v: boolean): void } {
  let active = initialActive;
  return {
    isActive: () => active,
    getState: () => 'idle' as const,
    getSttProvider: () => 'stub-stt',
    getTtsProvider: () => 'stub-tts',
    setActive(v: boolean) { active = v; },
  };
}

function makeStubBrowser(initialActive: boolean): BrowserServiceLike & { setActive(v: boolean): void } {
  let active = initialActive;
  return {
    isActive: () => active,
    setActive(v: boolean) { active = v; },
  };
}

describe('BaseOrgan dormant vs failed', () => {
  it('reports dormant for an organ that never activated (browser case)', () => {
    const browser = makeStubBrowser(false);
    const body = new DigitalBody({ browser });
    const browserOrgan = body.getOrgans().find(o => o.id === 'browser');
    expect(browserOrgan).toBeTruthy();
    // Before any activity tick, the organ is just dormant.
    expect(browserOrgan!.getHealth()).toBe('dormant');
  });

  it('flips an organ from healthy to failed when its service dies after activation', () => {
    const browser = makeStubBrowser(true);
    const body = new DigitalBody({ browser });
    const browserOrgan = body.getOrgans().find(o => o.id === 'browser')!;

    // Initial poll while alive — should be healthy and prime wasEverActive.
    expect(browserOrgan.getHealth()).toBe('healthy');

    // External death.
    browser.setActive(false);

    // Now the organ knows it's a "was up, lost it" failure, not a fresh dormant.
    expect(browserOrgan.getHealth()).toBe('failed');
  });

  it('VoiceOrgan respects the same dormant-vs-failed transition', () => {
    const voice = makeStubVoice(true);
    const body = new DigitalBody({ voice });
    const voiceOrgan = body.getOrgans().find(o => o.id === 'voice')!;

    // Healthy initially (both providers + active service).
    expect(voiceOrgan.getHealth()).toBe('healthy');

    voice.setActive(false);
    // Now it should be `failed` — not `dormant`. This is the regression.
    expect(voiceOrgan.getHealth()).toBe('failed');
  });

  it('VoiceOrgan still reports dormant if it was never active at all', () => {
    const voice = makeStubVoice(false);
    const body = new DigitalBody({ voice });
    const voiceOrgan = body.getOrgans().find(o => o.id === 'voice')!;
    expect(voiceOrgan.getHealth()).toBe('dormant');
  });
});
