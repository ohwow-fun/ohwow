import { describe, it, expect } from 'vitest';
import { detectTriggerPhrase, X_DM_TRIGGER_PHRASES } from '../x-dm-triggers.js';

describe('detectTriggerPhrase', () => {
  it('returns null on null/undefined/empty', () => {
    expect(detectTriggerPhrase(null)).toBeNull();
    expect(detectTriggerPhrase(undefined)).toBeNull();
    expect(detectTriggerPhrase('')).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(detectTriggerPhrase('What is your PRICING like?')).toBe('pricing');
    expect(detectTriggerPhrase('quick Demo please')).toBe('demo');
  });

  it('returns the first-matching phrase when multiple appear', () => {
    // "pricing" sits earlier in X_DM_TRIGGER_PHRASES than "demo" → wins.
    const hit = detectTriggerPhrase('Can we do a demo and talk pricing?');
    expect(hit).toBe('pricing');
  });

  it('matches multi-word phrases', () => {
    expect(detectTriggerPhrase('saw your npx ohwow post')).toBe('npx ohwow');
  });

  it('returns null when no phrase matches', () => {
    expect(detectTriggerPhrase('just saying hi, thanks for the follow')).toBeNull();
  });

  it('honors an explicit override list', () => {
    expect(detectTriggerPhrase('I want to buy the yellow widget', ['widget'])).toBe('widget');
    expect(detectTriggerPhrase('I want to buy the yellow widget', ['sprocket'])).toBeNull();
  });

  it('the default list is non-empty and lowercase', () => {
    expect(X_DM_TRIGGER_PHRASES.length).toBeGreaterThan(0);
    for (const p of X_DM_TRIGGER_PHRASES) {
      expect(p).toBe(p.toLowerCase());
    }
  });
});
