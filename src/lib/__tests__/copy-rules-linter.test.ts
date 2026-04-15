import { describe, it, expect } from 'vitest';
import {
  COPY_RULES,
  lintCopy,
  formatViolation,
} from '../copy-rules-linter.js';

describe('lintCopy', () => {
  it('returns [] for non-string input', () => {
    expect(lintCopy(null)).toEqual([]);
    expect(lintCopy(undefined)).toEqual([]);
    expect(lintCopy(42)).toEqual([]);
    expect(lintCopy('')).toEqual([]);
  });

  it('flags "Failed to" and proposes a "Couldn\'t" rewrite', () => {
    const vs = lintCopy('Failed to load agents.');
    expect(vs).toHaveLength(1);
    expect(vs[0].ruleId).toBe('no-failed-to');
    expect(vs[0].severity).toBe('error');
    expect(vs[0].suggest).toBe("Couldn't");
  });

  it('flags (s) pluralization', () => {
    const vs = lintCopy('You have 3 task(s) pending.');
    expect(vs.map((v) => v.ruleId)).toEqual(['no-paren-s']);
  });

  it('flags em and en dashes separately', () => {
    const vs = lintCopy('done — really – done');
    const ids = vs.map((v) => v.ruleId);
    expect(ids).toContain('no-em-dash');
    expect(ids).toContain('no-en-dash');
  });

  it('flags "please" case-insensitively', () => {
    expect(lintCopy('Please enter a title').map((v) => v.ruleId)).toContain('no-please');
    expect(lintCopy('please enter a title').map((v) => v.ruleId)).toContain('no-please');
  });

  it('flags "Unable to" but not "unable to" in arbitrary prose', () => {
    expect(lintCopy('Unable to connect').map((v) => v.ruleId)).toContain('no-unable-to');
  });

  it('flags "An error occurred" case-insensitively', () => {
    expect(lintCopy('an error occurred while saving').map((v) => v.ruleId)).toContain(
      'no-an-error-occurred',
    );
  });

  it('returns multiple occurrences of the same rule in index order', () => {
    const vs = lintCopy('Failed to save. Failed to reload.');
    expect(vs).toHaveLength(2);
    expect(vs[0].index).toBeLessThan(vs[1].index);
    expect(vs.every((v) => v.ruleId === 'no-failed-to')).toBe(true);
  });

  it('clean text has no violations', () => {
    const ok = "Couldn't load agents. Try refreshing.";
    expect(lintCopy(ok)).toEqual([]);
  });
});

describe('COPY_RULES', () => {
  it('has stable ids and no duplicates', () => {
    const ids = COPY_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe('formatViolation', () => {
  it('renders a single-line trace with severity, rule, index', () => {
    const [v] = lintCopy('Failed to bar');
    const line = formatViolation(v);
    expect(line).toContain('[error]');
    expect(line).toContain('no-failed-to');
    expect(line).toContain('@0');
  });
});
