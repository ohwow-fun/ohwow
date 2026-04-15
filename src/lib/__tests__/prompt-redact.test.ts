import { describe, it, expect } from 'vitest';
import { redactForPrompt, redactForPromptDeep } from '../prompt-redact.js';

describe('redactForPrompt', () => {
  it('replaces a real email with a deterministic placeholder', () => {
    const r = redactForPrompt('contact: real@gmail.com');
    expect(r.redacted).not.toContain('real@gmail.com');
    expect(r.redacted).toMatch(/redacted-[0-9a-f]{8}@example\.com/);
    expect(r.replacements).toHaveLength(1);
    expect(r.replacements[0].kind).toBe('personal-email');
    expect(r.replacements[0].original).toBe('real@gmail.com');
  });

  it('is deterministic: same input → same placeholder', () => {
    const a = redactForPrompt('ping real@gmail.com');
    const b = redactForPrompt('ping real@gmail.com');
    expect(a.redacted).toBe(b.redacted);
  });

  it('is consistent: same real email twice in one input → same placeholder both times', () => {
    const r = redactForPrompt('real@gmail.com and again real@gmail.com');
    const matches = r.redacted.match(/redacted-[0-9a-f]{8}@example\.com/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe(matches[1]);
    expect(r.replacements).toHaveLength(1); // single unique original
  });

  it('maps different real emails to different placeholders', () => {
    const r = redactForPrompt('a@gmail.com and b@gmail.com');
    const matches = r.redacted.match(/redacted-[0-9a-f]{8}@example\.com/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(matches[0]).not.toBe(matches[1]);
  });

  it('leaves placeholder domains alone', () => {
    const r = redactForPrompt('use alice@example.com as the example');
    expect(r.redacted).toBe('use alice@example.com as the example');
    expect(r.replacements).toEqual([]);
  });

  it('also leaves example.org / example.net / acme.test alone', () => {
    const r = redactForPrompt('emails: a@example.org, b@example.net, c@acme.test');
    expect(r.redacted).toBe('emails: a@example.org, b@example.net, c@acme.test');
    expect(r.replacements).toEqual([]);
  });

  it('redacts personal URLs but not the repo org', () => {
    const r = redactForPrompt(
      'see https://github.com/someuser/project and https://github.com/ohwow-fun/ohwow',
    );
    expect(r.redacted).toContain('https://example.com/redacted-');
    expect(r.redacted).toContain('https://github.com/ohwow-fun/ohwow');
    // Matches the owner segment only — trailing /project stays in the text.
    expect(r.replacements.some((x) => x.original === 'https://github.com/someuser')).toBe(true);
    expect(r.replacements.some((x) => x.original.startsWith('https://github.com/ohwow-fun'))).toBe(false);
  });

  it('redacts x.com and linkedin handles', () => {
    const r = redactForPrompt('https://x.com/someone and https://linkedin.com/in/someone-else');
    expect(r.redacted).not.toContain('x.com/someone');
    expect(r.redacted).not.toContain('linkedin.com/in/someone-else');
    expect(r.replacements.map((x) => x.kind).every((k) => k === 'url-with-identifier')).toBe(true);
  });

  it('redacts plausible phone numbers, skips too-short digit runs', () => {
    const r = redactForPrompt('call +1 415 555 2071 or ext 4242');
    expect(r.redacted).not.toContain('415 555 2071');
    expect(r.redacted).toContain('ext 4242'); // 4 digits, below threshold
  });

  it('returns empty replacements on clean input', () => {
    const r = redactForPrompt('just text with no identifiers');
    expect(r.replacements).toEqual([]);
    expect(r.redacted).toBe('just text with no identifiers');
  });

  it('is idempotent on already-redacted output', () => {
    const once = redactForPrompt('real@gmail.com');
    const twice = redactForPrompt(once.redacted);
    expect(twice.redacted).toBe(once.redacted);
    expect(twice.replacements).toEqual([]);
  });
});

describe('redactForPromptDeep', () => {
  it('walks arrays and objects and redacts every string leaf', () => {
    const input = {
      profiles: [
        { email: 'a@gmail.com', name: 'Alice' },
        { email: 'b@example.com', name: 'Bob' }, // placeholder, untouched
      ],
      summary: 'pinged a@gmail.com twice',
    };
    const r = redactForPromptDeep(input);
    const json = JSON.stringify(r.redacted);
    expect(json).not.toContain('a@gmail.com');
    expect(json).toContain('b@example.com'); // placeholder preserved
    // Same real address in two spots → single replacements entry.
    expect(r.replacements).toHaveLength(1);
    expect(r.replacements[0].original).toBe('a@gmail.com');
  });

  it('leaves non-string primitives alone', () => {
    const r = redactForPromptDeep({ n: 7, b: true, s: null, arr: [1, 2, 3] });
    expect(r.redacted).toEqual({ n: 7, b: true, s: null, arr: [1, 2, 3] });
    expect(r.replacements).toEqual([]);
  });
});
