import { describe, expect, it } from 'vitest';

import { SEL } from '../selectors.js';

/**
 * Syntactic sanity checks. Does NOT require a live Studio — we just
 * want to catch typos (unbalanced brackets, malformed attribute
 * selectors) before they hit runtime.
 *
 * Runtime mount checks live in scripts/x-experiments/yt-selector-audit.mjs.
 */

describe('selectors.ts', () => {
  const entries = Object.entries(SEL);

  it('exports a non-empty registry', () => {
    expect(entries.length).toBeGreaterThan(10);
  });

  it('every selector is a non-empty string', () => {
    for (const [key, value] of entries) {
      expect(typeof value, key).toBe('string');
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  it('every selector parses as a valid CSS selector', () => {
    // jsdom / node doesn't have document, but the `css-select` syntax
    // rules we care about can be approximated by asking querySelector
    // on a throwaway DOMParser result when available, or by a simple
    // regex parseability check. We use the regex route so the test
    // has no jsdom dependency.
    //
    // Allow attribute selectors, pseudo-classes, compound forms,
    // comma groups, and >, + combinators.
    const BAD_CHARS = /[{}`]/;
    const UNBALANCED = (s: string) =>
      (s.match(/\[/g)?.length ?? 0) !== (s.match(/\]/g)?.length ?? 0) ||
      (s.match(/\(/g)?.length ?? 0) !== (s.match(/\)/g)?.length ?? 0);
    for (const [key, value] of entries) {
      expect(BAD_CHARS.test(value), `${key} has suspicious chars: ${value}`).toBe(false);
      expect(UNBALANCED(value), `${key} has unbalanced brackets: ${value}`).toBe(false);
    }
  });

  it('no duplicate selector strings under different keys', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [key, value] of entries) {
      const prev = seen.get(value);
      if (prev) dupes.push(`${key} and ${prev} both point at "${value}"`);
      else seen.set(value, key);
    }
    // Allow *explicit* shared selectors when the keys are related —
    // we currently use VISIBILITY_RADIOS === META_KIDS_RADIOS because
    // both are paper-radio groups selected by name attribute. If you
    // add more duplicates, audit and either dedupe or narrow the selector.
    const allowed = new Set([
      // Visibility radios and Made-for-kids radios are both paper-radios
      // distinguished by their `name` attribute at scan time — same tag.
      'VISIBILITY_RADIOS and META_KIDS_RADIOS both point at "tp-yt-paper-radio-button"',
      // The upload-wizard title box and the per-video edit-page title box
      // are literally the same Polymer component. Dedupe would leak upload
      // vs read intent at the call site — accept the alias.
      'VIDEO_TITLE_READ and META_TITLE_BOX both point at "#title-textarea #textbox"',
      'VIDEO_DESCRIPTION_READ and META_DESCRIPTION_BOX both point at "#description-textarea #textbox"',
    ]);
    const unexpected = dupes.filter((d) => !allowed.has(d));
    expect(unexpected).toEqual([]);
  });
});
