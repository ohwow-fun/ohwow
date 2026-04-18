import { describe, it, expect } from 'vitest';
import {
  isKeeper,
  viralPiggybackVerdict,
  type ReplyClassifierVerdict,
} from '../reply-target-classifier.js';
import type { ReplyCandidate } from '../reply-target-selector.js';

function v(partial: Partial<ReplyClassifierVerdict>): ReplyClassifierVerdict {
  return {
    class: partial.class ?? 'genuine_pain',
    pain_domain: partial.pain_domain ?? null,
    severity: partial.severity ?? 0,
    specificity: partial.specificity ?? 0,
    sellerish: partial.sellerish ?? 0,
    rationale: partial.rationale ?? '',
  };
}

describe('isKeeper', () => {
  it('accepts genuine_pain with sellerish<=1', () => {
    expect(isKeeper(v({ class: 'genuine_pain', sellerish: 0 }))).toBe(true);
    expect(isKeeper(v({ class: 'genuine_pain', sellerish: 1 }))).toBe(true);
  });

  it('rejects genuine_pain with sellerish>=2 (vent is a sales setup)', () => {
    expect(isKeeper(v({ class: 'genuine_pain', sellerish: 2 }))).toBe(false);
    expect(isKeeper(v({ class: 'genuine_pain', sellerish: 3 }))).toBe(false);
  });

  it('accepts solo_service_provider up to sellerish=3', () => {
    // Solopreneurs announcing availability include CTAs/links by
    // nature — classifier honestly labels them sellerish=2-3.
    expect(isKeeper(v({ class: 'solo_service_provider', sellerish: 0 }))).toBe(true);
    expect(isKeeper(v({ class: 'solo_service_provider', sellerish: 2 }))).toBe(true);
    expect(isKeeper(v({ class: 'solo_service_provider', sellerish: 3 }))).toBe(true);
  });

  it('accepts viral_piggyback (classifier skipped in viral mode)', () => {
    expect(isKeeper(v({ class: 'viral_piggyback', sellerish: 0 }))).toBe(true);
  });

  it('rejects ai_seller, consultant_pitch, ai_enthusiast, generic_noise', () => {
    expect(isKeeper(v({ class: 'ai_seller' }))).toBe(false);
    expect(isKeeper(v({ class: 'ai_enthusiast' }))).toBe(false);
    expect(isKeeper(v({ class: 'consultant_pitch' }))).toBe(false);
    expect(isKeeper(v({ class: 'generic_noise' }))).toBe(false);
  });

  it('rejects error / null / undefined', () => {
    expect(isKeeper(v({ class: 'error' }))).toBe(false);
    expect(isKeeper(null)).toBe(false);
    expect(isKeeper(undefined)).toBe(false);
  });
});

describe('viralPiggybackVerdict', () => {
  const candidate: ReplyCandidate = {
    id: '1',
    url: 'https://x.com/foo/status/1',
    authorHandle: 'foo',
    text: 'solo founder viral post',
    replies: 50,
    likes: 200,
    reposts: 10,
    postedAt: null,
    isReply: false,
    isRepost: false,
  };

  it('returns class viral_piggyback with non-zero severity + specificity', () => {
    const result = viralPiggybackVerdict(candidate);
    expect(result.class).toBe('viral_piggyback');
    expect(result.severity).toBeGreaterThan(0);
    expect(result.specificity).toBeGreaterThan(0);
    expect(result.sellerish).toBe(0);
  });

  it('passes isKeeper', () => {
    const result = viralPiggybackVerdict(candidate);
    expect(isKeeper(result)).toBe(true);
  });
});
