import { describe, expect, it } from 'vitest';

import { coerceValue } from '../sync-runtime-to-cloud.js';

/**
 * Regression pin for the Trio 4 sync arc bug:
 * coerceValue used to blindly return JSON.parse(value) for any
 * `_json`-suffixed column. When the parsed value was a JS array, the
 * `pg` driver bound it as a Postgres array literal ({a,b}) instead of
 * JSON, causing "invalid input syntax for type json" on every upsert
 * with an array-shaped jsonb column (e.g. x_reply_drafts.alternates_json).
 *
 * Narrow fix: if JSON.parse yields an Array, return JSON.stringify(parsed)
 * so pg sends it as a JSON string the server upcasts to jsonb cleanly.
 */
describe('coerceValue (sync-runtime-to-cloud)', () => {
  it('returns the parsed object for a `_json` column whose value is a JSON object string', () => {
    const out = coerceValue('verdict_json', '{"key":"v"}');
    expect(out).toEqual({ key: 'v' });
    expect(Array.isArray(out)).toBe(false);
  });

  it('returns a JSON-stringified array (NOT a JS array) for a `_json` column whose value is a JSON array string', () => {
    // This is the regression. If this returns a JS array, pg renders it as
    // a Postgres array literal ({a,b}) and the jsonb upsert fails.
    const out = coerceValue('alternates_json', '["a","b"]');
    expect(typeof out).toBe('string');
    expect(out).toBe('["a","b"]');
    // And the server-side parse round-trips to the same array shape:
    expect(JSON.parse(out as string)).toEqual(['a', 'b']);
  });

  it('returns null for null input regardless of column suffix', () => {
    expect(coerceValue('alternates_json', null)).toBe(null);
    expect(coerceValue('whatever', null)).toBe(null);
  });

  it('returns the raw string for a non-`_json` column', () => {
    expect(coerceValue('reply_to_url', 'https://x.com/foo/status/1')).toBe(
      'https://x.com/foo/status/1',
    );
  });

  it('returns the original raw string for a `_json` column whose value is not valid JSON (graceful fallback)', () => {
    expect(coerceValue('alternates_json', 'not-json{')).toBe('not-json{');
  });
});
